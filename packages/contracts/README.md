# Demo contracts

`src/demo.ts` is the only wire-contract source. `pnpm --filter @msva/contracts export`
rewrites the checked-in JSON Schema 2020-12 and OpenAPI 3.1 artifacts;
`pnpm --filter @msva/contracts check` rejects drift without writing files.

The artifacts describe planned, unmounted service endpoints. They carry no caller
verification, media, provider, or storage authority: a caller payload cannot assert
identity, test status, an attachment receipt, a connected lookup, or staff completion.
