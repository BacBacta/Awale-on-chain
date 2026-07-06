// Single source for stake-token DISPLAY (decimals + symbol). Every screen reads
// THESE — never its own process.env with a divergent 6/18 default — so the same
// on-chain amount can't render 10^12× off between two tabs (it did: LiveMatch
// defaulted 6, WeeklyLeague 18). Mainnet sets both env vars to the real token
// (USDC 6, cUSD 18, …); the default matches the testnet aUSD (18) so an unset
// env is still internally consistent rather than silently wrong on one screen.

export const STAKE_DECIMALS = Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "18");
export const STAKE_SYMBOL = process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "aUSD";
