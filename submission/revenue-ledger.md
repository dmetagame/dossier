# Revenue ledger

Compiled 2026-08-04, updated 2026-08-05, from `onchainos agent tasks --agent-id 7012` and per-task
`onchainos agent status`. Every job id below is on-chain on X Layer and can be
checked independently; nothing here is self-reported.

This file exists because the marketplace counter is not a revenue figure. It
counts every completed task, including the ones we paid for ourselves while
testing. Presenting "28 sold" as organic traction would be false, and a project
whose whole product claim is that it refuses to guess cannot round its own
numbers up.

## Reconciliation

| | Tasks |
|---|---|
| Total tasks where Dossier (#7012) is the ASP | 31 |
| — completed | **29** (the marketplace "sold" counter) |
| — accepted, payment not yet released by the buyer | 1 |
| — closed unaccepted (our own duplicate, closed 2026-08-04) | 1 |

Of the **29 completed**:

| | Tasks | Gross |
|---|---|---|
| **External buyers** | **12** | **4.04 USD₮0** |
| Internal, self-paid from our own agent #9444 | 17 | not revenue |

## External buyers

Six distinct agents, none of them ours. Buyer ids are the marketplace's own
public agent ids, so these are verifiable rather than anonymised claims.

| Buyer | Tasks | Price each | Gross | Status |
|---|---|---|---|---|
| #1757 | 5 | 0.5 | 2.50 | all complete |
| #4844 | 4 | 0.5 ×1, 0.01 ×3 | 0.53 | 3 complete, 1 accepted (0.5, unreleased) |
| #1908 | 1 | 0.5 | 0.50 | complete |
| #5009 | 1 | 0.5 | 0.50 | complete |
| #5632 | 1 | 0.5 | 0.50 | complete |
| #6058 | 1 | 0.01 | 0.01 | complete |

**#1757 bought five times.** That is the single most useful number here: a
repeat external buyer is evidence the report was worth paying for more than
once, which no amount of first-purchase volume demonstrates.

Job ids, external only:

```
#1757  0x69121d8c95b8394e4995f77b1a77d2bb80aa39e0c80ee6e6912b87ae640be3bc  0.5   complete
#1757  0x3c4b647806c55fb6994122155a0a3d2947550c60024f55642e0edb750c5ddf35  0.5   complete
#1757  0x5a6c2f62a3e8753887c71ef2a14424a85e881c6fc1b81b45513e9f9e1291eb78  0.5   complete
#1757  0x8d5be419ba56fa9abc3d50a15b2efa4699b04b379d5151876f8abbc436951941  0.5   complete
#1757  0xda94bfefd7c66db73145900532fa2529d8662c0e4bbb8a5f98ae3bdde9fe2c0a  0.5   complete
#1908  0x4267c3f4117b797daf02feadb2b82e3baeb411762b7e621f5108baf0f0ff4d49  0.5   complete
#5009  0x78218f9f0dc0fe445537cb4e3ec64763af918a57d7255e46ce336faca6f15964  0.5   complete
#5632  0xd7f5ef56db52d79464d2104d5cfc6f073e18ab0189ee5dbf5c23d5fe3d977f3b  0.5   complete
#4844  0x9885537ccb3432027992cb0794ffb717dedff085546064e8bc7dc320e09c3b50  0.01  complete
#4844  0x64ba4bbc0afdeac88e4d299b528880545f7d6e64d7cd8897d4ab41af2f2b0609  0.01  complete
#6058  0xf58635e4820be370376055c9f12b9765216ffcefd79eb65db2197ae3da53590a  0.01  complete
#4844  0xae5f60a18196663531e2985a2c9cc2e879ca0300ed68bad7dda67b82008b4963  0.01  complete
#4844  0x2fa7c6c1d7c4c1b0b0ae63078ea197347afb22cc99d128f64f478a9001336a0d  0.5   accepted, not released
```

The last row is delivered but never closed by the buyer. Our own fulfilment
record for it reads `delivered manually after buyer went silent`. It is excluded
from the 4.04 figure because the payment has not been released, and it should
stay excluded unless it completes.

## Internal, self-paid

17 completed tasks purchased from our own user agent #9444, at both the old 0.5
price and the current 0.01. These are development and verification runs, not
sales. Three of them are from 2026-08-04 and were driven deliberately to exercise
the paid path end to end after changes to the payment middleware:

```
0xa4d89ff0…  first live x402 settlement check
0xc4716819…  delivery-message format and recovery-code check
0x99ba627b…  settlement on the rewritten payment middleware
0x9017217a…  the fulfilment watcher's ask → reply → deliver cycle
```

The price change matters when reading the older rows: the listing was 0.5 USD₮0
until 2026-07-28 and 0.01 since, so task count and gross do not move together.

## What we will and will not claim

**Will:** endpoint live; OKX.AI listing under review; 29 completed tasks, 12 of them
from 6 distinct external buyers, one of whom purchased five times, and 4.04 USD₮0
of external gross settled through x402 on X Layer.

**Will not:** "28 sales" as organic traction. The counter includes 17 of our own
purchases, and saying otherwise would be the kind of rounding this product is
built to refuse.
