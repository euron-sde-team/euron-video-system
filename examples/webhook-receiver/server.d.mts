/** Returns null when the signature is valid, else the reason it is not. */
export declare const verify: (secret: string, rawBody: string, header: string | undefined, nowSeconds?: number) => string | null;
