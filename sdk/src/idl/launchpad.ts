/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/launchpad.json`.
 */
export type Launchpad = {
  "address": "AyhSsRnM6gdSSVEQjzTmXBzwnTKVguDZxsxx3E7Q9v2M",
  "metadata": {
    "name": "launchpad",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Bonding-curve token launchpad for Solana with automatic Raydium CPMM graduation"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "docs": [
        "Accepts a pending admin transfer."
      ],
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "newAdmin",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "buy",
      "docs": [
        "Buys tokens spending at most `sol_amount` lamports (fees included)."
      ],
      "discriminator": [
        102,
        6,
        61,
        18,
        1,
        218,
        235,
        234
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "curveVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "bondingCurve"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "buyerTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "buyer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "solAmount",
          "type": "u64"
        },
        {
          "name": "minTokenAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claimCreatorFees",
      "docs": [
        "Sends the accumulated creator fees to the token creator."
      ],
      "discriminator": [
        0,
        23,
        125,
        234,
        156,
        118,
        134,
        89
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true,
          "relations": [
            "bondingCurve"
          ]
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "bondingCurve.mint",
                "account": "bondingCurve"
              }
            ]
          }
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "collectProtocolFees",
      "docs": [
        "Sends the accumulated protocol fees of a curve to the fee recipient (permissionless)."
      ],
      "discriminator": [
        22,
        67,
        23,
        98,
        150,
        178,
        70,
        220
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "bondingCurve.mint",
                "account": "bondingCurve"
              }
            ]
          }
        },
        {
          "name": "feeRecipient",
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "createToken",
      "docs": [
        "Launches a new token on a bonding curve."
      ],
      "discriminator": [
        84,
        52,
        204,
        228,
        24,
        140,
        234,
        75
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true,
          "signer": true
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "curveVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "bondingCurve"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "feeRecipient",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "symbol",
          "type": "string"
        },
        {
          "name": "uri",
          "type": "string"
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "Creates the global config. Callable once, by the program upgrade authority."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "launchpadProgram",
          "address": "AyhSsRnM6gdSSVEQjzTmXBzwnTKVguDZxsxx3E7Q9v2M"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "configParams"
            }
          }
        }
      ]
    },
    {
      "name": "migrate",
      "docs": [
        "Moves the liquidity of a completed curve to Raydium CPMM (permissionless)."
      ],
      "discriminator": [
        155,
        234,
        231,
        146,
        236,
        158,
        162,
        30
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "curveVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "bondingCurve"
              },
              {
                "kind": "account",
                "path": "token2022Program"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "poolCreator",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  114,
                  101,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "poolCreatorToken",
          "writable": true
        },
        {
          "name": "poolCreatorWsol",
          "writable": true
        },
        {
          "name": "poolCreatorLp",
          "writable": true
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "feeRecipient",
          "writable": true
        },
        {
          "name": "raydiumProgram",
          "address": "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
        },
        {
          "name": "ammConfig"
        },
        {
          "name": "raydiumAuthority"
        },
        {
          "name": "poolState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  97,
                  121,
                  100,
                  105,
                  117,
                  109,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "lpMint",
          "writable": true
        },
        {
          "name": "token0Vault",
          "writable": true
        },
        {
          "name": "token1Vault",
          "writable": true
        },
        {
          "name": "createPoolFee",
          "writable": true
        },
        {
          "name": "observationState",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "sell",
      "docs": [
        "Sells exactly `token_amount` tokens for at least `min_sol_amount` lamports."
      ],
      "discriminator": [
        51,
        230,
        133,
        164,
        1,
        127,
        131,
        173
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "bondingCurve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "curveVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "bondingCurve"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "sellerTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "tokenAmount",
          "type": "u64"
        },
        {
          "name": "minSolAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setPaused",
      "docs": [
        "Emergency switches for token creation and trading."
      ],
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "createPaused",
          "type": "bool"
        },
        {
          "name": "tradingPaused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "transferAdmin",
      "docs": [
        "Proposes a new admin (two-step transfer)."
      ],
      "discriminator": [
        42,
        242,
        66,
        106,
        228,
        10,
        111,
        156
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "updateConfig",
      "docs": [
        "Replaces the admin-settable configuration values."
      ],
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "configParams"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "bondingCurve",
      "discriminator": [
        23,
        183,
        248,
        55,
        96,
        216,
        172,
        96
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    }
  ],
  "events": [
    {
      "name": "configUpdated",
      "discriminator": [
        40,
        241,
        230,
        122,
        11,
        19,
        198,
        194
      ]
    },
    {
      "name": "creatorFeesClaimed",
      "discriminator": [
        189,
        178,
        21,
        181,
        171,
        179,
        131,
        1
      ]
    },
    {
      "name": "curveCompleted",
      "discriminator": [
        1,
        174,
        164,
        127,
        219,
        129,
        243,
        14
      ]
    },
    {
      "name": "migrated",
      "discriminator": [
        2,
        66,
        164,
        53,
        158,
        122,
        128,
        236
      ]
    },
    {
      "name": "protocolFeesCollected",
      "discriminator": [
        165,
        34,
        125,
        155,
        15,
        86,
        99,
        191
      ]
    },
    {
      "name": "tokenCreated",
      "discriminator": [
        236,
        19,
        41,
        255,
        130,
        78,
        147,
        172
      ]
    },
    {
      "name": "trade",
      "discriminator": [
        24,
        254,
        218,
        152,
        253,
        43,
        18,
        81
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Signer is not authorized to perform this action"
    },
    {
      "code": 6001,
      "name": "invalidConfig",
      "msg": "Invalid configuration parameters"
    },
    {
      "code": 6002,
      "name": "feeTooHigh",
      "msg": "Total fee exceeds the maximum allowed"
    },
    {
      "code": 6003,
      "name": "createPaused",
      "msg": "Token creation is paused"
    },
    {
      "code": 6004,
      "name": "tradingPaused",
      "msg": "Trading is paused"
    },
    {
      "code": 6005,
      "name": "invalidName",
      "msg": "Token name is empty or too long"
    },
    {
      "code": 6006,
      "name": "invalidSymbol",
      "msg": "Token symbol is empty or too long"
    },
    {
      "code": 6007,
      "name": "invalidUri",
      "msg": "Metadata URI is empty or too long"
    },
    {
      "code": 6008,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6009,
      "name": "amountTooSmall",
      "msg": "Amount is too small to be traded"
    },
    {
      "code": 6010,
      "name": "slippageExceeded",
      "msg": "Slippage tolerance exceeded"
    },
    {
      "code": 6011,
      "name": "curveNotTrading",
      "msg": "The bonding curve is not trading anymore"
    },
    {
      "code": 6012,
      "name": "curveNotComplete",
      "msg": "The bonding curve is not complete yet"
    },
    {
      "code": 6013,
      "name": "insufficientReserves",
      "msg": "Insufficient SOL reserves in the bonding curve"
    },
    {
      "code": 6014,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6015,
      "name": "invalidFeeRecipient",
      "msg": "Fee recipient does not match the configuration"
    },
    {
      "code": 6016,
      "name": "invalidRaydiumAccount",
      "msg": "Account does not match the Raydium configuration"
    },
    {
      "code": 6017,
      "name": "raydiumPoolCreationDisabled",
      "msg": "Raydium pool creation is disabled for the configured AMM config"
    },
    {
      "code": 6018,
      "name": "insufficientMigrationFunds",
      "msg": "Not enough SOL raised to cover the migration costs"
    },
    {
      "code": 6019,
      "name": "nothingToClaim",
      "msg": "Nothing to claim"
    },
    {
      "code": 6020,
      "name": "noPendingAdmin",
      "msg": "No pending admin transfer"
    }
  ],
  "types": [
    {
      "name": "bondingCurve",
      "docs": [
        "State of a single token launch.",
        "",
        "SOL reserves and unclaimed fees are held as lamports of this very account,",
        "so trades only lock per-token accounts and different tokens trade in",
        "parallel. Invariant: `lamports >= rent + real_sol_reserves + protocol_fees +",
        "creator_fees`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "virtualSolReserves",
            "type": "u64"
          },
          {
            "name": "virtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "realSolReserves",
            "type": "u64"
          },
          {
            "name": "realTokenReserves",
            "type": "u64"
          },
          {
            "name": "tokenTotalSupply",
            "type": "u64"
          },
          {
            "name": "protocolFees",
            "docs": [
              "Unclaimed protocol fees (lamports held by this account)."
            ],
            "type": "u64"
          },
          {
            "name": "creatorFees",
            "docs": [
              "Unclaimed creator fees (lamports held by this account)."
            ],
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "curveStatus"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "completedAt",
            "type": "i64"
          },
          {
            "name": "raydiumPool",
            "docs": [
              "Raydium CPMM pool address once migrated."
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "config",
      "docs": [
        "Global launchpad configuration, controlled by the admin.",
        "",
        "Curve parameters only apply to tokens created *after* a change: every",
        "bonding curve snapshots its reserves at creation time. Fees are read at",
        "trade time and are capped by [`MAX_TOTAL_FEE_BPS`]."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "docs": [
              "Two-step admin transfer target (`Pubkey::default()` when none)."
            ],
            "type": "pubkey"
          },
          {
            "name": "feeRecipient",
            "docs": [
              "Receives protocol trading fees, creation fees and migration fees."
            ],
            "type": "pubkey"
          },
          {
            "name": "initialVirtualSolReserves",
            "docs": [
              "Virtual SOL reserves of a new curve (lamports)."
            ],
            "type": "u64"
          },
          {
            "name": "initialVirtualTokenReserves",
            "docs": [
              "Virtual token reserves of a new curve (base units)."
            ],
            "type": "u64"
          },
          {
            "name": "initialRealTokenReserves",
            "docs": [
              "Tokens sold through the curve; when they run out the curve is complete."
            ],
            "type": "u64"
          },
          {
            "name": "tokenTotalSupply",
            "docs": [
              "Fixed total supply minted at creation. `token_total_supply -",
              "initial_real_token_reserves` is reserved for the DEX liquidity."
            ],
            "type": "u64"
          },
          {
            "name": "protocolFeeBps",
            "type": "u16"
          },
          {
            "name": "creatorFeeBps",
            "type": "u16"
          },
          {
            "name": "creationFeeLamports",
            "docs": [
              "Flat fee charged to the creator when launching a token."
            ],
            "type": "u64"
          },
          {
            "name": "migrationFeeLamports",
            "docs": [
              "Flat fee taken from the raised SOL when the token graduates."
            ],
            "type": "u64"
          },
          {
            "name": "raydiumAmmConfig",
            "docs": [
              "Raydium CPMM pool parameters used at graduation (the program itself",
              "is the compile-time constant [`RAYDIUM_CPMM_PROGRAM_ID`]).",
              "AMM config = fee tier of the pool; must be owned by the Raydium program."
            ],
            "type": "pubkey"
          },
          {
            "name": "raydiumCreatePoolFee",
            "docs": [
              "Raydium's pool creation fee receiver (validated by Raydium itself)."
            ],
            "type": "pubkey"
          },
          {
            "name": "createPaused",
            "type": "bool"
          },
          {
            "name": "tradingPaused",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved space for future upgrades without a migration."
            ],
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          }
        ]
      }
    },
    {
      "name": "configParams",
      "docs": [
        "Admin-settable configuration values (everything except admin and pause flags)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feeRecipient",
            "type": "pubkey"
          },
          {
            "name": "initialVirtualSolReserves",
            "type": "u64"
          },
          {
            "name": "initialVirtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "initialRealTokenReserves",
            "type": "u64"
          },
          {
            "name": "tokenTotalSupply",
            "type": "u64"
          },
          {
            "name": "protocolFeeBps",
            "type": "u16"
          },
          {
            "name": "creatorFeeBps",
            "type": "u16"
          },
          {
            "name": "creationFeeLamports",
            "type": "u64"
          },
          {
            "name": "migrationFeeLamports",
            "type": "u64"
          },
          {
            "name": "raydiumAmmConfig",
            "type": "pubkey"
          },
          {
            "name": "raydiumCreatePoolFee",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "configUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "feeRecipient",
            "type": "pubkey"
          },
          {
            "name": "protocolFeeBps",
            "type": "u16"
          },
          {
            "name": "creatorFeeBps",
            "type": "u16"
          },
          {
            "name": "createPaused",
            "type": "bool"
          },
          {
            "name": "tradingPaused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "creatorFeesClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "curveCompleted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "realSolReserves",
            "type": "u64"
          },
          {
            "name": "virtualSolReserves",
            "type": "u64"
          },
          {
            "name": "virtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "curveStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "trading"
          },
          {
            "name": "complete"
          },
          {
            "name": "migrated"
          }
        ]
      }
    },
    {
      "name": "migrated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "lpMint",
            "type": "pubkey"
          },
          {
            "name": "poolSolAmount",
            "docs": [
              "SOL (wrapped) deposited into the pool."
            ],
            "type": "u64"
          },
          {
            "name": "poolTokenAmount",
            "docs": [
              "Tokens deposited into the pool."
            ],
            "type": "u64"
          },
          {
            "name": "burnedTokenAmount",
            "docs": [
              "Surplus tokens burned to align the pool price with the curve price."
            ],
            "type": "u64"
          },
          {
            "name": "burnedLpAmount",
            "docs": [
              "LP tokens burned (liquidity locked forever)."
            ],
            "type": "u64"
          },
          {
            "name": "protocolAmount",
            "docs": [
              "Protocol revenue collected at migration (migration fee + unclaimed protocol fees + leftovers)."
            ],
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "protocolFeesCollected",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "feeRecipient",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tokenCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "bondingCurve",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "symbol",
            "type": "string"
          },
          {
            "name": "uri",
            "type": "string"
          },
          {
            "name": "virtualSolReserves",
            "type": "u64"
          },
          {
            "name": "virtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "realTokenReserves",
            "type": "u64"
          },
          {
            "name": "tokenTotalSupply",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "trade",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "isBuy",
            "type": "bool"
          },
          {
            "name": "solAmount",
            "docs": [
              "Lamports entering (buy) or leaving (sell) the curve, fees excluded."
            ],
            "type": "u64"
          },
          {
            "name": "tokenAmount",
            "type": "u64"
          },
          {
            "name": "protocolFee",
            "type": "u64"
          },
          {
            "name": "creatorFee",
            "type": "u64"
          },
          {
            "name": "virtualSolReserves",
            "docs": [
              "Reserves after the trade."
            ],
            "type": "u64"
          },
          {
            "name": "virtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "realSolReserves",
            "type": "u64"
          },
          {
            "name": "realTokenReserves",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "bondingCurveSeed",
      "docs": [
        "Per-token bonding curve PDA: `[BONDING_CURVE_SEED, mint]`.",
        "It is the mint authority during creation, owns the token vault and",
        "holds the SOL reserves (as lamports) while the token trades on the curve."
      ],
      "type": "bytes",
      "value": "[98, 111, 110, 100, 105, 110, 103, 95, 99, 117, 114, 118, 101]"
    },
    {
      "name": "configSeed",
      "docs": [
        "Global configuration PDA: `[CONFIG_SEED]`."
      ],
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "maxCreationFeeLamports",
      "type": "u64",
      "value": "1000000000"
    },
    {
      "name": "maxMigrationFeeLamports",
      "type": "u64",
      "value": "10000000000"
    },
    {
      "name": "maxNameLen",
      "docs": [
        "Metadata limits (Token-2022 metadata extension, stored on the mint itself)."
      ],
      "type": "u16",
      "value": "32"
    },
    {
      "name": "maxSymbolLen",
      "type": "u16",
      "value": "10"
    },
    {
      "name": "maxTotalFeeBps",
      "docs": [
        "Hard caps that the admin cannot exceed (protects traders from a malicious or",
        "mistaken configuration)."
      ],
      "type": "u16",
      "value": "500"
    },
    {
      "name": "maxUriLen",
      "type": "u16",
      "value": "200"
    },
    {
      "name": "poolCreatorSeed",
      "docs": [
        "Per-token, system-owned PDA used during graduation: `[POOL_CREATOR_SEED, mint]`.",
        "It pays for and signs the Raydium CPMM pool creation, receives the LP tokens",
        "and burns them. It is fully drained at the end of the migration."
      ],
      "type": "bytes",
      "value": "[112, 111, 111, 108, 95, 99, 114, 101, 97, 116, 111, 114]"
    },
    {
      "name": "raydiumCpmmProgramId",
      "docs": [
        "Raydium CPMM program that receives the liquidity at graduation.",
        "",
        "Compiled into the program (not configurable) so that nobody, not even the",
        "admin, can redirect the liquidity of a completed curve to another program.",
        "Build with `--features devnet` for devnet."
      ],
      "type": "pubkey",
      "value": "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
    },
    {
      "name": "raydiumPoolSeed",
      "docs": [
        "Per-token PDA used as the Raydium CPMM `pool_state` address: `[RAYDIUM_POOL_SEED, mint]`.",
        "Using an address that only this program can sign for (instead of the canonical",
        "CPMM PDA) makes the migration impossible to front-run or grief."
      ],
      "type": "bytes",
      "value": "[114, 97, 121, 100, 105, 117, 109, 95, 112, 111, 111, 108]"
    },
    {
      "name": "tokenDecimals",
      "docs": [
        "Decimals of every token launched through the launchpad."
      ],
      "type": "u8",
      "value": "6"
    }
  ]
};
