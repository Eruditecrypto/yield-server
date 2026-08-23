const { gql } = require('graphql-request');
const {
  CHAIN,
  USD_DECIMALS,
  assetVariantMeta,
  encodedAssetSegment,
  fromFixed,
  requestGraphql,
  toPercent,
} = require('../rujira-staking/common');

const ANALYTICS_API = 'https://analytics.rujira.network/api/graphql';
const CCL_RANGE_CONCURRENCY = 5;
const MAX_CONNECTION_PAGES = 20;
const PROJECT = 'rujira-amm-strategies';

const FIN_PAIRS_QUERY = gql`
  query RujiraFinPairs($after: String) {
    finV3 {
      pairs(first: 200, after: $after, sortBy: NAME, sortDir: ASC) {
        pageInfo {
          endCursor
          hasNextPage
        }
        edges {
          node {
            address
            assetBase {
              asset
              chain
              metadata {
                symbol
              }
            }
            assetQuote {
              asset
              chain
              metadata {
                symbol
              }
            }
          }
        }
      }
    }
  }
`;

const CCL_RANGES_QUERY = gql`
  query RujiraCclRanges($after: String, $contracts: [Address!]) {
    finV3 {
      ranges(first: 200, after: $after, contracts: $contracts, status: OPEN) {
        pageInfo {
          endCursor
          hasNextPage
        }
        edges {
          node {
            valueUsd
            analytics {
              apr
            }
          }
        }
      }
    }
  }
`;

const getAnalyticsConnectionNodes = async (
  query,
  connectionAt,
  variables = {}
) => {
  const nodes = [];
  let after = null;
  const seenCursors = new Set();

  for (let page = 0; page < MAX_CONNECTION_PAGES; page++) {
    const data = await requestGraphql(ANALYTICS_API, query, {
      ...variables,
      after,
    });
    const connection = connectionAt(data);
    if (!connection?.edges || !connection.pageInfo) {
      throw new Error(
        'Rujira Analytics GraphQL returned a malformed connection'
      );
    }

    nodes.push(...connection.edges.map((edge) => edge?.node).filter(Boolean));

    if (!connection.pageInfo.hasNextPage) break;
    if (page === MAX_CONNECTION_PAGES - 1) {
      throw new Error(
        'Rujira Analytics GraphQL exceeded the maximum page count'
      );
    }

    after = connection.pageInfo.endCursor;
    if (!after) {
      throw new Error('Rujira Analytics GraphQL omitted the next page cursor');
    }
    if (seenCursors.has(after)) {
      throw new Error(
        'Rujira Analytics GraphQL returned a repeated page cursor'
      );
    }
    seenCursors.add(after);
  }

  return nodes;
};

const getFinPairs = () =>
  getAnalyticsConnectionNodes(FIN_PAIRS_QUERY, (data) => data?.finV3?.pairs);

const getCclRangeGroups = async (contracts) => {
  const results = [];

  for (let i = 0; i < contracts.length; i += CCL_RANGE_CONCURRENCY) {
    const chunk = contracts.slice(i, i + CCL_RANGE_CONCURRENCY);
    results.push(
      ...(await Promise.allSettled(
        chunk.map((contract) =>
          getAnalyticsConnectionNodes(
            CCL_RANGES_QUERY,
            (data) => data?.finV3?.ranges,
            { contracts: [contract] }
          ).then((ranges) => ({ contract, ranges }))
        )
      ))
    );
  }

  const fulfilled = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  );
  if (!fulfilled.length && contracts.length) {
    const reason = results.find(
      (result) => result.status === 'rejected'
    )?.reason;
    throw reason || new Error('Rujira Analytics returned no CCL range data');
  }

  return fulfilled;
};

const getCclPools = async () => {
  const pairs = await getFinPairs();
  const contracts = pairs.map((pair) => pair?.address).filter(Boolean);
  const rangeGroups = await getCclRangeGroups(contracts);
  const pairsByAddress = new Map(
    pairs
      .filter((pair) => pair?.address)
      .map((pair) => [pair.address.toLowerCase(), pair])
  );

  return rangeGroups
    .map(({ contract: rawContract, ranges }) => {
      const contract = rawContract.toLowerCase();
      const pair = pairsByAddress.get(contract);
      const base = pair?.assetBase;
      const quote = pair?.assetQuote;
      const baseSymbol = base?.metadata?.symbol;
      const quoteSymbol = quote?.metadata?.symbol;
      const baseToken = base?.asset?.toLowerCase();
      const quoteToken = quote?.asset?.toLowerCase();
      const baseRoute = encodedAssetSegment(base);
      const quoteRoute = encodedAssetSegment(quote);
      const variantLabels = [assetVariantMeta(base), assetVariantMeta(quote)]
        .filter(Boolean)
        .map((variant) => variant.asset);
      let tvlUsd = 0;
      let weightedApy = 0;

      for (const range of ranges) {
        const valueUsd = fromFixed(range?.valueUsd, USD_DECIMALS);
        if (valueUsd === null || valueUsd <= 0) continue;

        tvlUsd += valueUsd;
        const rangeApy = toPercent(range?.analytics?.apr);
        if (rangeApy !== null) weightedApy += valueUsd * rangeApy;
      }

      const apyBase = tvlUsd > 0 ? weightedApy / tvlUsd : 0;

      if (
        !contract ||
        !baseSymbol ||
        !quoteSymbol ||
        !baseToken ||
        !quoteToken ||
        !baseRoute ||
        !quoteRoute ||
        tvlUsd <= 0 ||
        !Number.isFinite(apyBase)
      ) {
        return null;
      }

      return {
        pool: contract,
        chain: CHAIN,
        project: PROJECT,
        symbol: `${baseSymbol}-${quoteSymbol}`,
        tvlUsd,
        apyBase,
        underlyingTokens: [baseToken, quoteToken],
        poolMeta: variantLabels.length
          ? `CCL (${variantLabels.join('/')})`
          : 'CCL',
        url: `https://rujira.network/trade/${baseRoute}/${quoteRoute}?type=automated`,
      };
    })
    .filter(Boolean);
};

module.exports = {
  protocolId: '8396',
  timetravel: false,
  apy: getCclPools,
  url: 'https://rujira.network/trade',
};
