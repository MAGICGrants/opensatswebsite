import { NextApiRequest, NextApiResponse } from 'next'
import { FundSlug } from '@prisma/client'
import { z } from 'zod'
import path from 'path'

import { getProjects } from '../../utils/md'
import { env } from '../../env.mjs'
import { btcpayApi, prisma } from '../../server/services'
import { CURRENCY } from '../../config'
import {
  BtcPayCreateInvoiceRes,
  BtcPayGetPaymentMethodsRes,
  BtcPayGetRatesRes,
  DonationMetadata,
} from '../../server/types'

const ASSETS = ['BTC', 'XMR', 'USD'] as const

type Asset = (typeof ASSETS)[number]

type ResponseBody = {
  title: string
  fund: FundSlug
  date: string
  author: string
  url: string
  raised_amount_percent: number
  contributions: number
  target_amount_btc: number
  target_amount_xmr: number
  target_amount_usd: number
  address_btc: string
  address_xmr: string
}[]

type ResponseBodySpecificAsset = {
  title: string
  fund: FundSlug
  date: string
  author: string
  url: string
  raised_amount_percent: number
  contributions: number
  asset: Asset
  target_amount: number
  address: string | null
}[]

const querySchema = z.object({ asset: z.enum(ASSETS).optional() })

async function handle(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).end(`Method ${req.method} Not Allowed`)
  }

  const query = await querySchema.parseAsync(req.query)

  const projects = await getProjects()
  const notFundedProjects = projects.filter((project) => !project.isFunded)

  const rates: Record<string, number | undefined> = {}

  // Get exchange rates if target asset is not USD (or if there is no target asset)
  if (query.asset !== 'USD') {
    const assetsWithoutUsd = ASSETS.filter((asset) => asset !== 'USD')
    const params = assetsWithoutUsd.map((asset) => `currencyPair=${asset}`).join('&')
    const { data: _rates } = await btcpayApi.get<BtcPayGetRatesRes>(`/rates?${params}`)

    _rates.forEach((rate) => {
      const asset = rate.currencyPair.split('_')[0] as string
      rates[asset] = Number(rate.rate)
    })
  }

  const responseBody: ResponseBody = await Promise.all(
    notFundedProjects.map(async (project): Promise<ResponseBody[0]> => {
      const existingAddresses = await prisma.projectAddresses.findFirst({
        where: { projectSlug: project.slug, fundSlug: project.fund },
      })

      let bitcoinAddress = ''
      let moneroAddress = ''

      // Create invoice if there's no existing address
      if (!existingAddresses) {
        const metadata: DonationMetadata = {
          userId: null,
          donorName: null,
          donorEmail: null,
          projectSlug: project.slug,
          projectName: project.title,
          fundSlug: project.slug as FundSlug,
          isMembership: 'false',
          isSubscription: 'false',
          isTaxDeductible: 'false',
          staticGeneratedForApi: 'true',
        }

        const invoiceCreateResponse = await btcpayApi.post<BtcPayCreateInvoiceRes>('/invoices', {
          currency: CURRENCY,
          metadata,
        })

        const invoiceId = invoiceCreateResponse.data.id

        const paymentMethodsResponse = await btcpayApi.get<BtcPayGetPaymentMethodsRes>(
          `/invoices/${invoiceId}/payment-methods`
        )

        paymentMethodsResponse.data.forEach((paymentMethod: any) => {
          if (paymentMethod.paymentMethod === 'BTC-OnChain') {
            bitcoinAddress = paymentMethod.destination
          }

          if (paymentMethod.paymentMethod === 'XMR') {
            moneroAddress = paymentMethod.destination
          }
        })
      }

      if (existingAddresses) {
        bitcoinAddress = existingAddresses.bitcoinAddress
        moneroAddress = existingAddresses.moneroAddress
      }

      return {
        title: project.title,
        fund: project.fund,
        date: project.date,
        author: project.nym,
        url: path.join(env.APP_URL, project.fund, project.slug),
        target_amount_btc: rates.BTC ? project.goal / rates.BTC : 0,
        target_amount_xmr: rates.XMR ? project.goal / rates.XMR : 0,
        target_amount_usd: project.goal,
        address_btc: bitcoinAddress,
        address_xmr: moneroAddress,
        raised_amount_percent:
          (project.totaldonationsinfiatxmr +
            project.totaldonationsinfiatbtc +
            project.fiattotaldonationsinfiat) /
          project.goal,
        contributions: project.numdonationsbtc + project.numdonationsxmr + project.fiatnumdonations,
      }
    })
  )

  if (query.asset) {
    const responseBodySpecificAsset: ResponseBodySpecificAsset = responseBody.map((project) => {
      const amounts: Record<Asset, number> = {
        BTC: project.target_amount_btc,
        XMR: project.target_amount_xmr,
        USD: project.target_amount_usd,
      }

      const addresses: Record<Asset, string | null> = {
        BTC: project.address_btc,
        XMR: project.address_xmr,
        USD: null,
      }

      return {
        title: project.title,
        fund: project.fund,
        date: project.date,
        author: project.author,
        url: project.url,
        target_amount: amounts[query.asset!],
        address: addresses[query.asset!],
        raised_amount_percent: project.raised_amount_percent,
        contributions: project.contributions,
        asset: query.asset!,
      }
    })

    return responseBodySpecificAsset
  }

  return res.send(responseBody)
}

export default handle