import { add, gt, gte, mul, sub } from 'biggystring'
import {
  asDate,
  asMaybe,
  asNumber,
  asObject,
  asString,
  Cleaner
} from 'cleaners'
import {
  EdgeCorePluginOptions,
  EdgeCurrencyWallet,
  EdgeSpendInfo,
  EdgeSwapInfo,
  EdgeSwapPlugin,
  EdgeSwapQuote,
  EdgeSwapRequest,
  EdgeTransaction,
  SwapBelowLimitError,
  SwapCurrencyError
} from 'edge-core-js/types'

import {
  checkInvalidCodes,
  ensureInFuture,
  getCodesWithMainnetTranscription,
  InvalidCurrencyCodes,
  makeSwapPluginQuote
} from '../swap-helpers'
import { div18 } from '../util/biggystringplus'

const pluginId = 'swapuz'
const swapInfo: EdgeSwapInfo = {
  pluginId,
  displayName: 'Swapuz',
  supportEmail: 'support@swapuz.com'
}

const orderUri = 'https://swapuz.com/order/'
const uri = 'https://api.swapuz.com/api/home/v1/'

const dontUseLegacy: { [cc: string]: boolean } = {
  DGB: true
}

const INVALID_CURRENCY_CODES: InvalidCurrencyCodes = {
  from: {},
  to: {
    zcash: ['ZEC']
  }
}

// Network names that don't match parent network currency code
const MAINNET_CODE_TRANSCRIPTION = {
  binancesmartchain: 'BSC'
}

async function getAddress(
  wallet: EdgeCurrencyWallet,
  currencyCode: string
): Promise<string> {
  const addressInfo = await wallet.getReceiveAddress({ currencyCode })
  return addressInfo.legacyAddress != null && !dontUseLegacy[currencyCode]
    ? addressInfo.legacyAddress
    : addressInfo.publicAddress
}

export function makeSwapuzPlugin(opts: EdgeCorePluginOptions): EdgeSwapPlugin {
  const { initOptions, io } = opts
  const fetch = io.fetchCors ?? io.fetch

  if (initOptions.apiKey == null) {
    throw new Error('No Swapuz apiKey provided.')
  }
  const { apiKey } = initOptions

  const headers = {
    'Content-Type': 'application/json',
    'api-key': apiKey
  }

  const fetchSwapQuoteInner = async (
    request: EdgeSwapRequest
  ): Promise<EdgeSwapQuote> => {
    const { fromWallet, toWallet, nativeAmount, quoteFor } = request

    if (quoteFor === 'to') {
      throw new SwapCurrencyError(
        swapInfo,
        request.fromCurrencyCode,
        request.toCurrencyCode
      )
    }

    checkInvalidCodes(INVALID_CURRENCY_CODES, request, swapInfo)

    // Grab addresses:
    const [fromAddress, toAddress] = await Promise.all([
      getAddress(fromWallet, request.fromCurrencyCode),
      getAddress(toWallet, request.toCurrencyCode)
    ])

    const {
      fromCurrencyCode,
      toCurrencyCode,
      fromMainnetCode,
      toMainnetCode
    } = getCodesWithMainnetTranscription(request, MAINNET_CODE_TRANSCRIPTION)

    const largeDenomAmount = await fromWallet.nativeToDenomination(
      nativeAmount,
      fromCurrencyCode
    )

    const getQuote = async (mode: 'fix' | 'float'): Promise<EdgeSwapQuote> => {
      const getRateResponse = await fetch(
        uri +
          `rate/?mode=${mode}&amount=${largeDenomAmount}&from=${fromCurrencyCode}&to=${toCurrencyCode}&fromNetwork=${fromMainnetCode}&toNetwork=${toMainnetCode}`,
        { headers }
      )
      if (!getRateResponse.ok) {
        throw new Error(
          `Swapuz call returned error code ${getRateResponse.status}`
        )
      }

      const getRateJson = asApiResponse(asGetRate)(await getRateResponse.json())

      if (getRateJson.result == null)
        throw new SwapCurrencyError(swapInfo, fromCurrencyCode, toCurrencyCode)

      const { minAmount } = getRateJson.result

      if (gt(minAmount.toString(), largeDenomAmount)) {
        const nativeMinAmount = await fromWallet.denominationToNative(
          minAmount.toString(),
          fromCurrencyCode
        )
        throw new SwapBelowLimitError(swapInfo, nativeMinAmount)
      }

      // Create order
      const orderBody = {
        from: fromCurrencyCode,
        fromNetwork: fromMainnetCode,
        to: toCurrencyCode,
        toNetwork: toMainnetCode,
        address: toAddress,
        amount: parseFloat(largeDenomAmount),
        mode,
        addressUserFrom: fromAddress,
        addressRefound: fromAddress
      }

      const createOrderResponse = await fetch(uri + 'order', {
        method: 'POST',
        body: JSON.stringify(orderBody),
        headers
      })
      if (!createOrderResponse.ok) {
        throw new Error(
          `Swapuz call returned error code ${createOrderResponse.status}`
        )
      }

      const createOrderJson = asApiResponse(asCreateOrder)(
        await createOrderResponse.json()
      )

      if (createOrderJson.result == null) {
        throw new SwapCurrencyError(swapInfo, fromCurrencyCode, toCurrencyCode)
      }

      const {
        addressFrom,
        finishPayment,
        amountResult,
        uid,
        memoFrom
      } = createOrderJson.result

      const toNativeAmount = await toWallet.denominationToNative(
        amountResult.toString(),
        toCurrencyCode
      )

      const spendInfo: EdgeSpendInfo = {
        currencyCode: fromCurrencyCode,
        spendTargets: [
          {
            nativeAmount: request.nativeAmount,
            publicAddress: addressFrom,
            uniqueIdentifier: memoFrom
          }
        ],
        networkFeeOption: fromCurrencyCode === 'BTC' ? 'high' : 'standard',
        swapData: {
          orderId: uid,
          orderUri: orderUri + uid,
          isEstimate: mode === 'float',
          payoutAddress: toAddress,
          payoutCurrencyCode: toCurrencyCode,
          payoutNativeAmount: toNativeAmount,
          payoutWalletId: request.toWallet.id,
          plugin: { ...swapInfo },
          refundAddress: fromAddress
        }
      }

      const tx: EdgeTransaction = await request.fromWallet.makeSpend(spendInfo)

      return makeSwapPluginQuote(
        request,
        request.nativeAmount,
        toNativeAmount,
        tx,
        toAddress,
        pluginId,
        mode === 'float',
        ensureInFuture(finishPayment),
        uid
      )
    }

    // Try them all
    try {
      return await getQuote('fix')
    } catch (e) {
      try {
        return await getQuote('float')
      } catch (e2) {
        // Should throw the fixed-rate error
        throw e
      }
    }
  }

  const out: EdgeSwapPlugin = {
    swapInfo,

    async fetchSwapQuote(requestTop: EdgeSwapRequest): Promise<EdgeSwapQuote> {
      const {
        fromWallet,
        fromCurrencyCode,
        toWallet,
        toCurrencyCode,
        nativeAmount,
        quoteFor
      } = requestTop

      if (quoteFor === 'from') {
        return await fetchSwapQuoteInner(requestTop)
      } else {
        requestTop.quoteFor = 'from'
        const requestToExchangeAmount = await fromWallet.nativeToDenomination(
          nativeAmount,
          fromCurrencyCode
        )
        let fromQuoteNativeAmount = nativeAmount
        let retries = 5
        while (--retries !== 0) {
          requestTop.nativeAmount = fromQuoteNativeAmount
          const quote = await fetchSwapQuoteInner(requestTop)
          const toExchangeAmount = await toWallet.nativeToDenomination(
            quote.toNativeAmount,
            toCurrencyCode
          )
          if (gte(toExchangeAmount, requestToExchangeAmount)) {
            return quote
          } else {
            // Get the % difference between the FROM and TO amounts and increase the FROM amount
            // by that %
            const diff = sub(requestToExchangeAmount, toExchangeAmount)
            const percentDiff = div18(diff, requestToExchangeAmount)
            const diffMultiplier = add('1.001', percentDiff)
            fromQuoteNativeAmount = mul(diffMultiplier, fromQuoteNativeAmount)
          }
        }
        throw new SwapCurrencyError(swapInfo, fromCurrencyCode, toCurrencyCode)
      }
    }
  }
  return out
}

interface ApiResponse<T> {
  result: T | undefined
  status: number
}

const asApiResponse = <T>(cleaner: Cleaner<T>): Cleaner<ApiResponse<T>> =>
  asObject({
    result: asMaybe(cleaner),
    status: asNumber
  })

const asGetRate = asObject({
  // result: asNumber,
  // amount: asNumber,
  // rate: asNumber,
  // withdrawFee: asNumber,
  minAmount: asNumber
})

// const asNetwork = asObject({
//   shortName: asString,
//   isDeposit: asBoolean,
//   isWithdraw: asBoolean,
//   isMemo: asBoolean,
//   isActive: asBoolean
// })

const asCreateOrder = asObject({
  uid: asString,
  // from: asObject({
  //   shortName: asString,
  //   isMemo: asBoolean,
  //   isDeposit: asBoolean,
  //   isWithdraw: asBoolean,
  //   network: asArray(asNetwork)
  // }),
  // to: asObject({
  //   shortName: asString,
  //   isMemo: asBoolean,
  //   isDeposit: asBoolean,
  //   isWithdraw: asBoolean,
  //   network: asArray(asNetwork)
  // }),
  amount: asNumber,
  amountResult: asNumber,
  addressFrom: asString,
  addressTo: asString,
  // addressFromNetwork: asMaybe(asString),
  // addressToNetwork: asString,
  memoFrom: asMaybe(asString),
  // memoTo: asMaybe(asString),
  // createDate: asString,
  finishPayment: asDate
})