# groundwatch

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/lindaayu1200/groundwatch/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/lindaayu1200/groundwatch/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

GROUNDWATCH is a pre-launch ground radar: a launch-value model fitted on the snapshot's cleaned
traded protocols (log market cap on TVL, weekly growth and age, with a 1e-6 ridge; bad caps, extreme
mcap/TVL and one MAD residual pass removed), validated walk-forward and leave-one-out with median
absolute percentage error and RMSLE. Every ranked protocol gets token odds from peer issuance
(category base rate blended with the whole universe) and a concrete, costed farm verdict — FARM,
WATCH or SKIP — with dollar ranges, durations and a weekly action. Plans follow the protocol's
category: exchange points and earn products, on-chain liquidity, or a generic deposit-and-monitor
flow. Yield is estimated per day on a standard $1,000 farm, floored at $0.10. Values are capped at
$2T. All 40 watchlist slugs are covered, 40/40, with no network, framework or clock dependence.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /tmp/tr-kit/token-radar-01-kit/input/snapshot.json
```

342 board rows scored from 93 cleaned traded rows (51 dropped); walk-forward median APE 0.7743
(77.4%), leave-one-out median APE 0.7722 (77.2%) and RMSLE 0.4853 log10 units, all carried on every
row for audit.
