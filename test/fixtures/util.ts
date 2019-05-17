import { ExecutionContext } from "ava";
import * as lolex from "lolex";
import { inspect } from "util";
import { CommonOptions, log, Provider } from "../../index";
import { keysOf } from "../../src/shared";
import { Timing } from "./functions";
export { keysOf };

export const measureConcurrency = (timings: Timing[]) =>
    timings
        .map(t => t.start)
        .map(t => timings.filter(({ start, end }) => start <= t && t < end).length)
        .reduce((a, b) => Math.max(a, b));

export const sum = (a: number[]) => a.reduce((total, n) => total + n, 0);

export const avg = (a: number[]) => sum(a) / a.length;

export const stdev = (a: number[]) => {
    const average = avg(a);
    return Math.sqrt(avg(a.map(v => (v - average) ** 2)));
};

export type VClock = lolex.InstalledClock<lolex.Clock>;

export async function withClock(fn: (clock: VClock) => Promise<void>) {
    const clock = lolex.install({ shouldAdvanceTime: true, now: Date.now() });
    try {
        await fn(clock);
    } finally {
        clock.uninstall();
    }
}

export function checkResourcesCleanedUp<T extends object>(
    t: ExecutionContext,
    resources: T
) {
    for (const key of keysOf(resources)) {
        t.is(resources[key], undefined);
        if (resources[key] !== undefined) {
            console.log(`Resource '${key}' not cleaned up: %O`, resources[key]);
        }
    }
}

export interface RecordedCall<A extends any[], R> {
    args: A;
    rv: R;
}

export interface RecordedFunction<A extends any[], R> {
    (...args: A): R;
    recordings: Array<RecordedCall<A, R>>;
}

export function record<A extends any[], R>(fn: (...args: A) => R) {
    const func: RecordedFunction<A, R> = Object.assign(
        (...args: A) => {
            const rv = fn(...args);
            func.recordings.push({ args, rv });
            log.info(`func.recordings: %O`, func.recordings);
            return rv;
        },
        { recordings: [] }
    );
    return func;
}

export function contains<T extends U, U extends object>(container: T, obj: U) {
    for (const key of keysOf(obj)) {
        if (!(key in container) || container[key] !== obj[key]) {
            return false;
        }
    }
    log.gc(`Contains: %O, %O`, container, obj);
    return true;
}

export const configs: CommonOptions[] = [
    { mode: "https", childProcess: false, validateSerialization: true },
    { mode: "https", childProcess: true, validateSerialization: true },
    { mode: "queue", childProcess: false, validateSerialization: true },
    { mode: "queue", childProcess: true, validateSerialization: true }
];

export const noValidateConfigs = configs.map(c => ({
    ...c,
    validateSerialization: false
}));

export function title(provider: Provider, msg: string, options?: object) {
    const desc = options ? inspect(options, { breakLength: Infinity }) : "";
    return [provider === "local" ? "" : "remote", provider, msg, desc]
        .filter(x => x !== "")
        .join(" ");
}

export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
