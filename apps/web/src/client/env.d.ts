/// <reference types="vite/client" />

declare module "virtual:abtune-bank" {
  import type { Bank } from "@abtune/engine";

  const bank: Bank;
  export default bank;
}
