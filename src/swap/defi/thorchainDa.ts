import { toFixed } from 'biggystring'
import {
  asArray,
  asBoolean,
  asEither,
  asNull,
  asObject,
  asOptional,
  asString,
  asUnknown
} from 'cleaners'
import {
  EdgeCorePluginOptions,
  EdgeSpendInfo,
  EdgeSwapInfo,
  EdgeSwapPlugin,
  EdgeSwapQuote,
  EdgeSwapRequest,
  EdgeTransaction,
  JsonObject,
  SwapCurrencyError
} from 'edge-core-js/types'
import { ethers } from 'ethers'

import {
  checkInvalidCodes,
  getMaxSwappable,
  getTokenId,
  makeSwapPluginQuote,
  SwapOrder
} from '../../swap-helpers'
import {
  convertRequest,
  fetchInfo,
  fetchWaterfall,
  getAddress,
  makeQueryParams,
  promiseWithTimeout
} from '../../util/utils'
import { EdgeSwapRequestPlugin } from '../types'
import { abiMap } from './abi/abiMap'
import { getEvmApprovalData, getEvmTokenData } from './defiUtils'
import {
  asExchangeInfo,
  asInboundAddresses,
  asInitOptions,
  EVM_CURRENCY_CODES,
  EXCHANGE_INFO_UPDATE_FREQ_MS,
  EXPIRATION_MS,
  getGasLimit,
  INVALID_CURRENCY_CODES,
  MAINNET_CODE_TRANSCRIPTION,
  THORNODE_SERVERS_DEFAULT
} from './thorchain'

const pluginId = 'thorchainda'
const swapInfo: EdgeSwapInfo = {
  pluginId,
  isDex: true,
  displayName: 'Thorchain DEX Aggregator',
  supportEmail: 'support@edge.app'
}

// This needs to be a type so adding the '& {}' prevents auto correction to an interface
type ThorSwapQuoteParams = {
  sellAsset: string
  buyAsset: string
  sellAmount: string
  slippage: string // 5 = 5%
  recipientAddress: string
  senderAddress?: string
  affiliateAddress: string
  affiliateBasisPoints: string // '50' => 0.5%
} & {}

const asCalldata = asObject({
  tcMemo: asOptional(asString),
  memo: asOptional(asString)
})

const asThorSwapRoute = asObject({
  contract: asEither(asString, asNull),
  contractMethod: asEither(asString, asNull),
  contractInfo: asOptional(asString),
  complete: asBoolean,
  path: asString,
  providers: asArray(asString),
  calldata: asUnknown,
  expectedOutput: asString,
  expectedOutputMaxSlippage: asString,
  expectedOutputUSD: asString,
  expectedOutputMaxSlippageUSD: asString,
  deadline: asOptional(asString)
})

const asThorSwapQuoteResponse = asObject({
  routes: asArray(asThorSwapRoute)
})

const DA_VOLATILITY_SPREAD_DEFAULT = 0.03
const THORSWAP_DEFAULT_SERVERS = [
  'https://aggregator-prod-aulilvmdlq-uc.a.run.app'
]

type ExchangeInfo = ReturnType<typeof asExchangeInfo>

let exchangeInfo: ExchangeInfo | undefined
let exchangeInfoLastUpdate: number = 0

const tokenProxyMap: { [currencyPluginId: string]: string } = {
  ethereum: '0xf892fef9da200d9e84c9b0647ecff0f34633abe8',
  avalanche: '0x69ba883af416ff5501d54d5e27a1f497fbd97156'
}

export function makeThorchainDaPlugin(
  opts: EdgeCorePluginOptions
): EdgeSwapPlugin {
  const { io, log } = opts
  const { fetch } = io
  const {
    appId,
    affiliateFeeBasis,
    ninerealmsClientId,
    thorname
  } = asInitOptions(opts.initOptions)

  const headers = {
    'Content-Type': 'application/json',
    'x-client-id': ninerealmsClientId
  }

  const fetchSwapQuoteInner = async (
    request: EdgeSwapRequestPlugin
  ): Promise<SwapOrder> => {
    const {
      fromCurrencyCode,
      toCurrencyCode,
      nativeAmount,
      fromWallet,
      toWallet,
      quoteFor
    } = request
    // Do not support transfer between same assets
    if (
      fromWallet.currencyInfo.pluginId === toWallet.currencyInfo.pluginId &&
      request.fromCurrencyCode === request.toCurrencyCode
    ) {
      throw new SwapCurrencyError(swapInfo, fromCurrencyCode, toCurrencyCode)
    }
    const reverseQuote = quoteFor === 'to'
    const isEstimate = false

    let daVolatilitySpread: number = DA_VOLATILITY_SPREAD_DEFAULT
    let thornodeServers: string[] = THORNODE_SERVERS_DEFAULT
    let thorswapServers: string[] = THORSWAP_DEFAULT_SERVERS

    checkInvalidCodes(INVALID_CURRENCY_CODES, request, swapInfo)

    // Grab addresses:
    const fromAddress = await getAddress(fromWallet)
    const toAddress = await getAddress(toWallet)

    const fromMainnetCode =
      MAINNET_CODE_TRANSCRIPTION[fromWallet.currencyInfo.pluginId]
    const toMainnetCode =
      MAINNET_CODE_TRANSCRIPTION[toWallet.currencyInfo.pluginId]

    if (fromMainnetCode == null || toMainnetCode == null) {
      throw new SwapCurrencyError(swapInfo, fromCurrencyCode, toCurrencyCode)
    }

    const now = Date.now()
    if (
      now - exchangeInfoLastUpdate > EXCHANGE_INFO_UPDATE_FREQ_MS ||
      exchangeInfo == null
    ) {
      try {
        const exchangeInfoResponse = await promiseWithTimeout(
          fetchInfo(fetch, `v1/exchangeInfo/${appId}`)
        )

        if (exchangeInfoResponse.ok === true) {
          exchangeInfo = asExchangeInfo(await exchangeInfoResponse.json())
          exchangeInfoLastUpdate = now
        } else {
          // Error is ok. We just use defaults
          log.warn('Error getting info server exchangeInfo. Using defaults...')
        }
      } catch (e: any) {
        log.warn(
          'Error getting info server exchangeInfo. Using defaults...',
          e.message
        )
      }
    }

    if (exchangeInfo != null) {
      const { thorchain } = exchangeInfo.swap.plugins
      daVolatilitySpread = thorchain.daVolatilitySpread
      thorswapServers = thorchain.thorSwapServers ?? THORSWAP_DEFAULT_SERVERS
      thornodeServers = thorchain.thornodeServers ?? thornodeServers
    }

    const volatilitySpreadFinal = daVolatilitySpread // Might add a likeKind spread later

    //
    // Get Quote
    //
    if (reverseQuote) {
      throw new SwapCurrencyError(swapInfo, fromCurrencyCode, toCurrencyCode)
    }

    const sellAmount = await fromWallet.nativeToDenomination(
      nativeAmount,
      fromCurrencyCode
    )

    const fromIsToken = fromMainnetCode !== fromCurrencyCode
    const fromTokenId = fromIsToken
      ? `-0x${getTokenId(fromWallet, fromCurrencyCode) ?? ''}`
      : undefined
    const toIsToken = toMainnetCode !== toCurrencyCode
    const toTokenId = toIsToken
      ? `-0x${getTokenId(toWallet, toCurrencyCode) ?? ''}`
      : undefined
    const quoteParams: ThorSwapQuoteParams = {
      sellAsset: `${fromMainnetCode}.${fromCurrencyCode}` + (fromTokenId ?? ''),
      buyAsset: `${toMainnetCode}.${toCurrencyCode}` + (toTokenId ?? ''),
      sellAmount,
      slippage: (volatilitySpreadFinal * 100).toString(),
      recipientAddress: toAddress,
      senderAddress: fromAddress,
      affiliateAddress: thorname,
      affiliateBasisPoints: affiliateFeeBasis
    }
    const sourceTokenContractAddress = fromTokenId?.replace('-0x', '0x')

    const queryParams = makeQueryParams(quoteParams)
    const uri = `tokens/quote?${queryParams}`

    log.warn(uri)

    const [iaResponse, thorSwapResponse] = await Promise.all([
      fetchWaterfall(fetch, thornodeServers, 'thorchain/inbound_addresses', {
        headers
      }),
      fetchWaterfall(fetch, thorswapServers, uri, { headers })
    ])

    if (!iaResponse.ok) {
      const responseText = await iaResponse.text()
      throw new Error(
        `Thorchain could not fetch inbound_addresses: ${JSON.stringify(
          responseText,
          null,
          2
        )}`
      )
    }
    if (!thorSwapResponse.ok) {
      const responseText = await thorSwapResponse.text()
      throw new Error(
        `Thorchain could not get thorswap quote: ${JSON.stringify(
          responseText,
          null,
          2
        )}`
      )
    }

    const iaJson = await iaResponse.json()
    const inboundAddresses = asInboundAddresses(iaJson)

    const thorSwapJson = await thorSwapResponse.json()
    const thorSwapQuote = asThorSwapQuoteResponse(thorSwapJson)

    // Check for supported chain and asset
    const inAddressObject = inboundAddresses.find(
      addrObj => !addrObj.halted && addrObj.chain === fromMainnetCode
    )
    if (inAddressObject == null) {
      throw new SwapCurrencyError(swapInfo, fromCurrencyCode, toCurrencyCode)
    }
    const { router, address: thorAddress } = inAddressObject
    const { routes } = thorSwapQuote
    const [thorSwap] = routes

    if (thorSwap == null)
      throw new SwapCurrencyError(swapInfo, fromCurrencyCode, toCurrencyCode)

    const {
      providers,
      path,
      contractMethod,
      expectedOutputMaxSlippage
    } = thorSwap

    const calldata = asCalldata(thorSwap.calldata)

    if (providers.length <= 1) {
      throw new SwapCurrencyError(swapInfo, fromCurrencyCode, toCurrencyCode)
    }

    const tcDirect = providers[0] === 'THORCHAIN'

    const toNativeAmount = toFixed(
      await toWallet.denominationToNative(
        expectedOutputMaxSlippage,
        toCurrencyCode
      ),
      0,
      0
    )

    // let customNetworkFee
    // let customNetworkFeeKey

    // const customFeeTemplate = (fromWallet.currencyInfo.customFeeTemplate ??
    //   [])[0]
    // const fromCurrencyInfo = fromWallet.currencyInfo
    // if (customFeeTemplate?.type === 'nativeAmount') {
    //   customNetworkFee = inAssetGasRate
    //   customNetworkFeeKey = customFeeTemplate.key
    // } else if (fromCurrencyInfo.defaultSettings?.customFeeSettings != null) {
    //   const customFeeSettings = asCustomFeeSettings(
    //     fromCurrencyInfo.defaultSettings.customFeeSettings
    //   )
    //   // Only know about the key 'gasPrice'
    //   const usesGasPrice = customFeeSettings.find(f => f === 'gasPrice')
    //   if (usesGasPrice != null) {
    //     customNetworkFee = inAssetGasRate
    //     customNetworkFeeKey = 'gasPrice'
    //   }
    // }

    // if (customNetworkFee == null || customNetworkFeeKey == null) {
    //   throw new SwapCurrencyError(swapInfo, fromCurrencyCode, toCurrencyCode)
    // }

    let memo = calldata.tcMemo ?? calldata.memo ?? ''

    log.warn(memo)

    const contractAddress = tcDirect ? router : thorSwap.contract
    const calldataAny: any = thorSwap.calldata
    let ethNativeAmount = nativeAmount
    let publicAddress = thorAddress
    let approvalData

    if (EVM_CURRENCY_CODES[fromMainnetCode]) {
      if (fromMainnetCode !== fromCurrencyCode) {
        if (contractAddress == null)
          throw new Error(`Missing router address for ${fromMainnetCode}`)
        if (sourceTokenContractAddress == null)
          throw new Error(
            `Missing sourceTokenContractAddress for ${fromMainnetCode}`
          )
        // Need to use ethers.js to craft a proper tx that calls Thorchain contract, then extract the data payload
        // Token transactions send no ETH (or other EVM mainnet coin)
        if (tcDirect) {
          memo = await getEvmTokenData({
            assetAddress: sourceTokenContractAddress,
            amountToSwapWei: Number(nativeAmount),
            contractAddress,
            vaultAddress: thorAddress,
            memo
          })
        } else {
          if (contractMethod == null)
            throw new Error('Invalid null contractMethod')
          if (contractAddress == null)
            throw new Error('Invalid null contractAddress')

          memo = await getCalldataData(
            fromWallet.currencyInfo.pluginId,
            contractAddress,
            contractMethod,
            calldataAny
          )
        }

        ethNativeAmount = '0'
        publicAddress = contractAddress

        // Check if token approval is required and return necessary data field
        approvalData = await getEvmApprovalData({
          contractAddress: tokenProxyMap[fromWallet.currencyInfo.pluginId],
          assetAddress: sourceTokenContractAddress,
          nativeAmount: nativeAmount
        })
      } else {
        memo = '0x' + Buffer.from(memo).toString('hex')
      }
    } else {
      // Cannot yet do tokens on non-EVM chains
      if (fromMainnetCode !== fromCurrencyCode) {
        throw new SwapCurrencyError(swapInfo, fromCurrencyCode, toCurrencyCode)
      }
    }

    let preTx: EdgeTransaction | undefined
    if (approvalData != null) {
      const spendInfo: EdgeSpendInfo = {
        currencyCode: fromMainnetCode,
        spendTargets: [
          {
            memo: approvalData,
            nativeAmount: '0',
            publicAddress: sourceTokenContractAddress
          }
        ],
        metadata: {
          name: 'Thorchain DEX Aggregator',
          category: 'expense:Token Approval'
        }
      }
      preTx = await request.fromWallet.makeSpend(spendInfo)
    }

    const spendInfo: EdgeSpendInfo = {
      currencyCode: request.fromCurrencyCode,
      spendTargets: [
        {
          memo,
          nativeAmount: ethNativeAmount,
          publicAddress
        }
      ],

      swapData: {
        isEstimate,
        payoutAddress: toAddress,
        payoutCurrencyCode: toCurrencyCode,
        payoutNativeAmount: toNativeAmount,
        payoutWalletId: toWallet.id,
        plugin: { ...swapInfo }
      },
      otherParams: {
        outputSort: 'targets'
      }
    }

    if (EVM_CURRENCY_CODES[fromMainnetCode]) {
      if (fromMainnetCode === fromCurrencyCode) {
        // For mainnet coins of EVM chains, use gasLimit override since makeSpend doesn't
        // know how to estimate an ETH spend with extra data
        const gasLimit = getGasLimit(fromMainnetCode, fromCurrencyCode)
        if (gasLimit != null) {
          spendInfo.customNetworkFee = {
            ...spendInfo.customNetworkFee,
            gasLimit
          }
        }
      }
    }

    const providersStr = providers.join(' -> ')
    const notes = `DEX Providers: ${providersStr}\nPath: ${path}`

    return {
      request,
      spendInfo,
      swapInfo,
      fromNativeAmount: nativeAmount,
      expirationDate: new Date(Date.now() + EXPIRATION_MS),
      preTx,
      metadataNotes: notes
    }
  }

  const out: EdgeSwapPlugin = {
    swapInfo,

    async fetchSwapQuote(req: EdgeSwapRequest): Promise<EdgeSwapQuote> {
      const request = convertRequest(req)

      const newRequest = await getMaxSwappable(fetchSwapQuoteInner, request)
      const swapOrder = await fetchSwapQuoteInner(newRequest)
      return await makeSwapPluginQuote(swapOrder)
    }
  }
  return out
}

const calldataOrder = {
  TC_ROUTER_GENERIC: [
    'tcRouter',
    'tcVault',
    'tcMemo',
    'token',
    'amount',
    'router',
    'data',
    'deadline'
  ],
  TC_ROUTER_UNISWAP: [
    'tcRouter',
    'tcVault',
    'tcMemo',
    'token',
    'amount',
    'amountOutMin',
    'deadline'
  ],
  TC_ROUTER_PANGOLIN: [
    'tcRouter',
    'tcVault',
    'tcMemo',
    'token',
    'amount',
    'amountOutMin',
    'deadline'
  ]
}

export const getCalldataData = async (
  currencyPluginId: string,
  contractAddress: string,
  contractMethod: string,
  calldata: JsonObject
): Promise<string> => {
  let abi, contractType
  try {
    const { type, data } = abiMap[currencyPluginId][
      contractAddress.toLowerCase()
    ]
    if (type === 'INVALID') {
      throw new Error(`Unsupported contract`)
    }
    abi = data
    contractType = type
  } catch (e: any) {
    throw new Error(
      `Could not find ABI for contract ${currencyPluginId}-${contractAddress}`
    )
  }

  const contractParams = calldataOrder[contractType].map(key => calldata[key])

  // initialize contract
  const contract = new ethers.Contract(
    contractAddress,
    abi,
    ethers.providers.getDefaultProvider()
  )

  // call the deposit method on the contract
  const tx = await contract.populateTransaction[contractMethod](
    ...contractParams
  )
  if (tx.data == null) throw new Error('No data in tx object')
  return tx.data
}
