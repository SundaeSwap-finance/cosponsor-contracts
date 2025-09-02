export interface IVerificationKeyCredential {
  vkey: string;
}

export interface IScriptCredential {
  script: string;
}

export type TCredential = IVerificationKeyCredential | IScriptCredential;
