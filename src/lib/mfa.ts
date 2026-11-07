import { generateSecret, generate, verify, generateURI } from "otplib";
export const mfaSecret = () => generateSecret();
export const mfaUri = (secret: string, email: string) => generateURI({ secret, issuer: "BridgeBox", label: email });
export async function mfaVerify(secret: string, token: string): Promise<boolean> { const r = await verify({ secret, token: token.trim() }); return !!r?.valid; }
export const mfaGenerate = (secret: string) => generate({ secret });
