/**
 * MetaMask / EIP-1193 access for the browser. Read-only in this phase.
 *
 * Rules:
 *
 *   1. **No key material, ever.** The wallet holds the key. This module only asks which
 *      account and chain the wallet is on. There is no code path here that reads, accepts,
 *      stores or transmits a private key or seed phrase.
 *   2. **Nothing touches `window` at import time.** The provider is injected, so the module
 *      is unit-testable in Node against a fake wallet.
 *   3. **Optional.** Community profiles are read server-side with `eth_call`. Every feature in
 *      this app works with the wallet disconnected; connecting only shows an address and the
 *      network you are on, which is useful context during a demo.
 *
 * No ENS write path exists in this phase. Publishing the demo community's text records is a
 * later, MetaMask-signed step documented in `docs/profile-format.md`.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

export const SEPOLIA_CHAIN_ID = 11155111
export const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7'

export type WalletFailureReason =
  | 'no-provider'
  | 'user-rejected'
  | 'chain-not-added'
  | 'wrong-network'
  | 'disconnected'
  | 'rpc-error'

/**
 * A wallet problem, already phrased for the UI.
 *
 * "disconnected", "wrong network" and "rejected in your wallet" are kept distinct because
 * the fix differs in each case.
 */
export class WalletError extends Error {
  readonly reason: WalletFailureReason

  constructor(reason: WalletFailureReason, message: string) {
    super(message)
    this.name = 'WalletError'
    this.reason = reason
  }
}

interface ProviderErrorLike {
  code?: unknown
  message?: unknown
}

export function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null
  const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum
  return injected ?? null
}

export function hasInjectedProvider(): boolean {
  return getInjectedProvider() !== null
}

/** Read a chain id as a number from the `0x…` hex form wallets return. */
export function parseChainId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 16)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function describeChain(chainId: number | null): string {
  switch (chainId) {
    case 1:
      return 'Ethereum mainnet'
    case 11155111:
      return 'Sepolia'
    case 8453:
      return 'Base'
    case 42161:
      return 'Arbitrum One'
    case 10:
      return 'Optimism'
    case null:
      return 'an unknown network'
    default:
      return `chain ${chainId}`
  }
}

export function isSepoliaChain(chainId: number | null): boolean {
  return chainId === SEPOLIA_CHAIN_ID
}

/** Turn any thrown value into a `WalletError` with an actionable message. */
export function classifyWalletError(error: unknown, context: string): WalletError {
  if (error instanceof WalletError) return error

  const candidate = (error ?? {}) as ProviderErrorLike
  const code = typeof candidate.code === 'number' ? candidate.code : null
  const rawMessage = typeof candidate.message === 'string' ? candidate.message : String(error)

  if (code === 4001) {
    return new WalletError('user-rejected', `${context}: rejected in your wallet.`)
  }
  if (code === 4902) {
    return new WalletError('chain-not-added', `${context}: your wallet does not have Sepolia yet.`)
  }
  // Some wallets report a rejection as -32000 plus a marker in the message.
  if (code === -32000 && /rejected|denied|cancel/i.test(rawMessage)) {
    return new WalletError('user-rejected', `${context}: rejected in your wallet.`)
  }

  return new WalletError('rpc-error', `${context}: ${rawMessage}`)
}

export interface WalletConnection {
  readonly address: `0x${string}`
  readonly chainId: number
  readonly onSepolia: boolean
  readonly networkLabel: string
  readonly networkError: string | null
}

/**
 * Connect and report the current account and chain.
 *
 * Connecting on mainnet is not an error — it just means the demo's ENS context is not the
 * chain this app reads. Nothing here gates a feature.
 */
export async function connectWallet(provider: Eip1193Provider): Promise<WalletConnection> {
  let accounts: readonly string[]
  try {
    accounts = (await provider.request({ method: 'eth_requestAccounts' })) as readonly string[]
  } catch (error: unknown) {
    throw classifyWalletError(error, 'Connect wallet')
  }

  const address = accounts[0]
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new WalletError('disconnected', 'Your wallet returned no account. Unlock it and connect again.')
  }

  const chainId = parseChainId(await provider.request({ method: 'eth_chainId' }))
  const onSepolia = isSepoliaChain(chainId)

  return {
    address: address as `0x${string}`,
    chainId: chainId ?? -1,
    onSepolia,
    networkLabel: describeChain(chainId),
    networkError: onSepolia
      ? null
      : `Your wallet is on ${describeChain(chainId)}. The app reads ENS on Sepolia, so switch for a matching demo context — reading profiles works either way.`,
  }
}

/** Ask the wallet to move to Sepolia, adding the chain if it does not have it. */
export async function switchToSepolia(provider: Eip1193Provider): Promise<void> {
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
    })
  } catch (error: unknown) {
    const classified = classifyWalletError(error, 'Switch to Sepolia')
    if (classified.reason !== 'chain-not-added') throw classified

    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: SEPOLIA_CHAIN_ID_HEX,
            chainName: 'Sepolia',
            nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
            blockExplorerUrls: ['https://sepolia.etherscan.io'],
          },
        ],
      })
    } catch (addError: unknown) {
      throw classifyWalletError(addError, 'Add Sepolia to your wallet')
    }
  }
}

export interface WalletEventHandlers {
  onAccountsChanged(accounts: readonly string[]): void
  onChainChanged(chainIdHex: string): void
  onDisconnected(): void
}

/** Subscribe to wallet events so the UI never shows a stale address. */
export function subscribeToWallet(
  provider: Eip1193Provider,
  handlers: WalletEventHandlers,
): () => void {
  const onAccounts = (...args: unknown[]) => {
    handlers.onAccountsChanged((args[0] ?? []) as readonly string[])
  }
  const onChain = (...args: unknown[]) => {
    const value = args[0]
    handlers.onChainChanged(typeof value === 'string' ? value : SEPOLIA_CHAIN_ID_HEX)
  }
  const onDisconnect = () => handlers.onDisconnected()

  provider.on?.('accountsChanged', onAccounts)
  provider.on?.('chainChanged', onChain)
  provider.on?.('disconnect', onDisconnect)

  return () => {
    provider.removeListener?.('accountsChanged', onAccounts)
    provider.removeListener?.('chainChanged', onChain)
    provider.removeListener?.('disconnect', onDisconnect)
  }
}

/** Shorten an address for display without losing the recognisable ends. */
export function shortenAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}