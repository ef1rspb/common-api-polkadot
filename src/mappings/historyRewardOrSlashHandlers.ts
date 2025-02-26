import {AccumulatedReward, HistoryElement, HistoryReward} from '../types';
import {SubstrateBlock, SubstrateEvent, SubstrateExtrinsic} from "@subql/types";
import {
    callsFromBatch,
    eventIdFromBlockAndIdx,
    isBatch,
    eventId,
    isProxy,
    callFromProxy
} from "./helper";
import {CallBase} from "@polkadot/types/types/calls";
import {AnyTuple} from "@polkadot/types/types/codec";
import {EraIndex} from "@polkadot/types/interfaces/staking"
import {Balance} from "@polkadot/types/interfaces";

function isPayoutStakers(call: CallBase<AnyTuple>): boolean {
    return call.method == "payoutStakers"
}

function isPayoutValidator(call: CallBase<AnyTuple>): boolean {
    return call.method == "payoutValidator"
}

function extractArgsFromPayoutStakers(call: CallBase<AnyTuple>): [string, number] {
    const [validatorAddressRaw, eraRaw] = call.args

    return [validatorAddressRaw.toString(), (eraRaw as EraIndex).toNumber()]
}

function extractArgsFromPayoutValidator(call: CallBase<AnyTuple>, sender: string): [string, number] {
    const [eraRaw] = call.args

    return [sender, (eraRaw as EraIndex).toNumber()]
}

export async function handleRewardForHistoryElement(rewardEvent: SubstrateEvent): Promise<void> {
    await handleRewardForTxHistory(rewardEvent)
    await updateAccumulatedReward(rewardEvent, true)
}

async function handleRewardForTxHistory(rewardEvent: SubstrateEvent): Promise<void> {
    let element = await HistoryElement.get(eventId(rewardEvent))

    if (element !== undefined) {
        // already processed reward previously
        return;
    }

    let payoutCallsArgs = rewardEvent.block.block.extrinsics
        .map(extrinsic => determinePayoutCallsArgs(extrinsic.method, extrinsic.signer.toString()))
        .filter(args => args.length != 0)
        .flat()

    if (payoutCallsArgs.length == 0) {
        return
    }

    const distinctValidators = new Set(
        payoutCallsArgs.map(([validator,]) => validator)
    )

    const initialCallIndex = -1

    await buildRewardEvents(
        rewardEvent.block,
        rewardEvent.extrinsic,
        rewardEvent.event.method,
        rewardEvent.event.section,
        initialCallIndex,
        (currentCallIndex, eventAccount) => {
            return distinctValidators.has(eventAccount) ? currentCallIndex + 1 : currentCallIndex
        },
        (currentCallIndex, amount) => {
            const [validator, era] = payoutCallsArgs[currentCallIndex]

            return {
                eventIdx: rewardEvent.idx,
                amount: amount,
                isReward: true,
                validator: validator,
                era: era
            }
        }
    )
}

function determinePayoutCallsArgs(causeCall: CallBase<AnyTuple>, sender: string) : [string, number][] {
    if (isPayoutStakers(causeCall)) {
        return [extractArgsFromPayoutStakers(causeCall)]
    } else if (isPayoutValidator(causeCall)) {
        return [extractArgsFromPayoutValidator(causeCall, sender)]
    } else if (isBatch(causeCall)) {
        return callsFromBatch(causeCall)
            .map(call => {
                return determinePayoutCallsArgs(call, sender)
                    .map((value, index, array) => {
                        return value
                    })
            })
            .flat()
    } else if (isProxy(causeCall)) {
        let proxyCall = callFromProxy(causeCall)
        return determinePayoutCallsArgs(proxyCall, sender)
    } else {
        return []
    }
}

export async function handleSlashForHistoryElement(slashEvent: SubstrateEvent): Promise<void> {
    await handleSlashForTxHistory(slashEvent)
    await updateAccumulatedReward(slashEvent, false)
}

async function handleSlashForTxHistory(slashEvent: SubstrateEvent): Promise<void> {
    let element = await HistoryElement.get(eventId(slashEvent))

    if (element !== undefined) {
        // already processed reward previously
        return;
    }

    const currentEra = (await api.query.staking.currentEra()).unwrap()
    const slashDefferDuration = api.consts.staking.slashDeferDuration

    const slashEra = currentEra.toNumber() - slashDefferDuration.toNumber()

    const eraStakersInSlashEra = await api.query.staking.erasStakersClipped.entries(slashEra);
    const validatorsInSlashEra = eraStakersInSlashEra.map(([key, exposure]) => {
        let [, validatorId] = key.args

        return validatorId.toString()
    })
    const validatorsSet = new Set(validatorsInSlashEra)

    const initialValidator: string = ""

    await buildRewardEvents(
        slashEvent.block,
        slashEvent.extrinsic,
        slashEvent.event.method,
        slashEvent.event.section,
        initialValidator,
        (currentValidator, eventAccount) => {
            return validatorsSet.has(eventAccount) ? eventAccount : currentValidator
        },
        (validator, amount) => {

            return {
                eventIdx: slashEvent.idx,
                amount: amount,
                isReward: false,
                validator: validator,
                era: slashEra
            }
        }
    )
}

async function buildRewardEvents<A>(
    block: SubstrateBlock,
    extrinsic: SubstrateExtrinsic | undefined,
    eventMethod: String,
    eventSection: String,
    initialInnerAccumulator: A,
    produceNewAccumulator: (currentAccumulator: A, eventAccount: string) => A,
    produceReward: (currentAccumulator: A, amount: string) => HistoryReward
) {
    let blockNumber = block.block.header.number.toString()
    let blockTimestamp = block.timestamp

    const [, savingPromises] = block.events.reduce<[A, Promise<void>[]]>(
        (accumulator, eventRecord, eventIndex) => {
            let [innerAccumulator, currentPromises] = accumulator

            if (!(eventRecord.event.method == eventMethod && eventRecord.event.section == eventSection)) return accumulator

            let {event: {data: [account, amount]}} = eventRecord

            const newAccumulator = produceNewAccumulator(innerAccumulator, account.toString())

            const eventId = eventIdFromBlockAndIdx(blockNumber, eventIndex.toString())

            const element = new HistoryElement(eventId);

            element.timestamp = blockTimestamp
            element.address = account.toString()
            element.blockNumber = block.block.header.number.toNumber()
            if (extrinsic !== undefined) {
                element.extrinsicHash = extrinsic.extrinsic.hash.toString()
                element.extrinsicIdx = extrinsic.idx
            }
            element.reward = produceReward(newAccumulator, amount.toString())

            currentPromises.push(element.save())

            return [newAccumulator, currentPromises];
        }, [initialInnerAccumulator, []])

    await Promise.allSettled(savingPromises);
}

async function updateAccumulatedReward(event: SubstrateEvent, isReward: boolean): Promise<void> {
    let {event: {data: [accountId, amount]}} = event
    let accountAddress = accountId.toString()

    let accumulatedReward = await AccumulatedReward.get(accountAddress);
    if (!accumulatedReward) {
        accumulatedReward = new AccumulatedReward(accountAddress);
        accumulatedReward.amount = BigInt(0)
    }
    const newAmount = (amount as Balance).toBigInt()
    accumulatedReward.amount = accumulatedReward.amount + (isReward ? newAmount : -newAmount)
    await accumulatedReward.save()
}