use anchor_lang::prelude::*;

#[error_code]
pub enum LaunchpadError {
    #[msg("Signer is not authorized to perform this action")]
    Unauthorized,
    #[msg("Invalid configuration parameters")]
    InvalidConfig,
    #[msg("Total fee exceeds the maximum allowed")]
    FeeTooHigh,
    #[msg("Token creation is paused")]
    CreatePaused,
    #[msg("Trading is paused")]
    TradingPaused,
    #[msg("Token name is empty or too long")]
    InvalidName,
    #[msg("Token symbol is empty or too long")]
    InvalidSymbol,
    #[msg("Metadata URI is empty or too long")]
    InvalidUri,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Amount is too small to be traded")]
    AmountTooSmall,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("The bonding curve is not trading anymore")]
    CurveNotTrading,
    #[msg("The bonding curve is not complete yet")]
    CurveNotComplete,
    #[msg("Insufficient SOL reserves in the bonding curve")]
    InsufficientReserves,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Fee recipient must match the configuration and be a rent-exempt system account")]
    InvalidFeeRecipient,
    #[msg("Account does not match the Raydium configuration")]
    InvalidRaydiumAccount,
    #[msg("Raydium pool creation is disabled for the configured AMM config")]
    RaydiumPoolCreationDisabled,
    #[msg("Not enough SOL raised to cover the migration costs")]
    InsufficientMigrationFunds,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("No pending admin transfer")]
    NoPendingAdmin,
}
