import { CosponsorTypes } from "./GeneratedTypes";
import { PlutusV3Script } from "@blaze-cardano/core";

export class AlwaysTrue {
  public static script(): PlutusV3Script {
    return new CosponsorTypes.AlwaysTrueAlwaysTrueMint().Script.asPlutusV3()!;
  }
}
