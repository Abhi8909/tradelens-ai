import type { RolloverDataset } from "../../../../packages/core/src/rolloverTypes.ts";
export interface BhavcopyProvider {
  readonly kind: "fixture" | "verified";
  load(): RolloverDataset;
}
