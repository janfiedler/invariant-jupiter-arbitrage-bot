import got from "got";
import dotenv from "dotenv";
import Anchor from '@project-serum/anchor';
const { Wallet, Provider, BN, utils } = Anchor;
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Market, Pair, Network } from "@invariant-labs/sdk";
import { Keypair, PublicKey, Connection, VersionedTransaction } from "@solana/web3.js";
import { fromFee, simulateSwap, toPercent } from "@invariant-labs/sdk/lib/utils.js";
import JSBI from 'jsbi';

dotenv.config();
const { KEYPAIR, RPC_ENDPOINT } = process.env;

import { LPs } from './config.js';

// Try parse index of config from agruments
let indexOfLP = parseInt(process.argv[2], 10);
// Verify if parses index is number
indexOfLP = isNaN(indexOfLP) ? -1 : indexOfLP;

let secretKey = Uint8Array.from(JSON.parse(KEYPAIR));
const wallet = new Wallet(
    Keypair.fromSecretKey(secretKey)
);
let keypair = Keypair.fromSecretKey(secretKey);


let connection = new Connection(RPC_ENDPOINT, { confirmTransactionInitialTimeout: 30000 });

// Catch request to exit process, wait until round is finished
let running = true;
let countSigint = 0;

process.on('SIGINT', () => {
    console.log("Caught request to exit process, waiting until round is finished");
    if (countSigint > 0) {
        console.log("Caught request to exit process again, exiting now");
        process.exit(1);
    }
    countSigint++;
    running = false;
});

const sleep = function (ms) {
    return new Promise(resolve => {
        console.log(`Waiting ${ms / 1000} seconds before continue`);
        setTimeout(resolve, ms)
    })
};

const transferAmountToSolana = function (value, digits) {
    return Math.round(value * Math.pow(10, digits));
};

const transferAmountToUi = function (value, digits) {
    return value / Math.pow(10, digits);
};

function relDiff(a, b) {
    return 100 * Math.abs((a - b) / ((a + b) / 2));
}

async function getTokenAddressBalance(tokenOutAddress) {
    // Verify that tokenOut is zero in the wallet
    let tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        keypair.publicKey,
        { programId: TOKEN_PROGRAM_ID }
    );
    // Filter fromm all tokens in wallet only tokenOut address
    tokenAccounts.value = tokenAccounts.value.filter(
        (token) => token.account.data.parsed.info.mint === tokenOutAddress
    );
    //If tokenAccounts is empty, inform user need to create account for tokenOutAddress
    if (tokenAccounts.value.length === 0) {
        console.log(`Please first create account for tokenOutAddress ${tokenOutAddress}`);
        process.exit(1);
    }
    return tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
}

async function simulateInvariant(LP, fromInvariant, data, amountIn) {
    try {
        const { tokenX, tokenY, invariantFee } = LP;
        data.invariant.tokenXAddress = tokenX.address;
        data.invariant.tokenYAddress = tokenY.address;
        data.invariant.market = data.invariant.market === null ? await Market.build(Network.MAIN, keypair, connection) : data.invariant.market;
        data.invariant.pair = data.invariant.pair === null ? new Pair(new PublicKey(data.invariant.tokenXAddress), new PublicKey(data.invariant.tokenYAddress), invariantFee) : data.invariant.pair;

        data.invariant.ticks = new Map(
            (await data.invariant.market.getAllTicks(data.invariant.pair)).map(tick => {
                return [tick.index, tick]
            })
        )
        data.invariant.poolData = await data.invariant.market.getPool(data.invariant.pair);

        const result = await simulateSwap({
            xToY: fromInvariant,
            byAmountIn: true,
            swapAmount: new BN(amountIn),
            slippage: toPercent(data.invariant.slippage, 1),
            ticks: data.invariant.ticks,
            tickmap: await data.invariant.market.getTickmap(data.invariant.pair),
            pool: data.invariant.poolData
        });

        return result;
    } catch (error) {
        console.log("Invariant simulate exception:");
        console.log(error);
        return null;
    }
}

async function swapInvariant(fromInvariant, data, amount) {
    var logMessage = "\x1b[90mProcessing Invariant swap \x1b[0m \n";
    // Get the associated account for the token in wallet if not already found
    if (data.invariant.accountX === null || data.invariant.accountY === null) {
        const [accountX, accountY] = await Promise.all([
            PublicKey.findProgramAddress(
                [
                    keypair.publicKey.toBuffer(),
                    TOKEN_PROGRAM_ID.toBuffer(),
                    new PublicKey(data.invariant.tokenXAddress).toBuffer(),
                ],
                ASSOCIATED_TOKEN_PROGRAM_ID
            ),
            PublicKey.findProgramAddress(
                [
                    keypair.publicKey.toBuffer(),
                    TOKEN_PROGRAM_ID.toBuffer(),
                    new PublicKey(data.invariant.tokenYAddress).toBuffer(),
                ],
                ASSOCIATED_TOKEN_PROGRAM_ID
            )
        ]);
        data.invariant.accountX = accountX[0];
        data.invariant.accountY = accountY[0];
    }

    const swapVars = {
        xToY: fromInvariant,
        accountX: data.invariant.accountX,
        accountY: data.invariant.accountY,
        amount: new BN(amount),
        byAmountIn: true,
        estimatedPriceAfterSwap: { v: data.resultSimulateInvariant.priceAfterSwap },
        slippage: toPercent(data.invariant.slippage, 1),
        pair: data.invariant.pair,
        owner: keypair.publicKey,
    }

    //Perform the swap
    let resultInvariantSwap = await data.invariant.market.swap(swapVars, keypair);
    logMessage += "\x1b[34mInvariant\x1b[0m \x1b[32mswap done \x1b[0m \n";
    logMessage += `https://solscan.io/tx/${resultInvariantSwap}\n`;
    return [resultInvariantSwap, logMessage];
}

const getCoinQuote = async (onlyDirectRoutes, inputMint, outputMint, amount) => {
    try {
        const result = await got
            .get(
                `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=100&onlyDirectRoutes=${onlyDirectRoutes}`
            )
            .json();
        return [result, "\x1b[90mCoin quote fetched \x1b[0m \n"];
    } catch (error) {
        return [null, "\x1b[31mAn error occurred while fetching the coin quote: \x1b[0m" + error  + "\n"];
    }
};





const getTransaction = async (quoteResponse) => {
    try {
        const response = await got.post("https://quote-api.jup.ag/v6/swap", {
            headers: {
                'Content-Type': 'application/json'
            },
            json: {
                quoteResponse,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: false
            },
            responseType: 'json'
        });

        return [response.body, "\x1b[90mTransaction fetched \x1b[0m \n"];

    } catch (error) {
        return [null, "\x1b[31mAn error occurred while fetching the transaction: \x1b[0m" + error];
    }
};

async function simulateJupiter(onlyDirectRoutes, data, from, to, amount) {
    try {
        const routes = await getCoinQuote(
            onlyDirectRoutes,
            new PublicKey(from.address),
            new PublicKey(to.address),
            amount
        );
        return routes;
    } catch (error) {
        return [null, "\x1b[31mupiter simulate exception: \x1b[0m" + error + "\n"]
    }
    /*
    const routes = await jupiter.computeRoutes({
        inputMint: new PublicKey(from.address), // Mint address of the input token
        outputMint: new PublicKey(to.address), // Mint address of the output token
        amount, // raw input amount of tokens
        slippageBps: Math.ceil(data.jupiter.slippage*100), // The slippage in % terms
        forceFetch: true, // false is the default value => will use cache if not older than routeCacheDuration
        onlyDirectRoutes, // It ensures only direct routing and also disable split trade trading
        intermediateTokens: true, // intermediateTokens, if provided will only find routes that use the intermediate tokens
    });
    */

}

async function swapJupiter(routes) {
    let customMessage = "\x1b[90mProcessing jupiter swap \x1b[0m \n";
    try {
        const response = await getTransaction(routes);
        customMessage += response[1];
        if (response[0] === null) { return [null, response[1]]; }
        let swapTransaction = response[0].swapTransaction;

        if (typeof swapTransaction === 'undefined') {
            console.log('Undefined swapTransaction');
            process.exit(0);
        }
        else {
            // deserialize the transaction
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            //console.log(transaction);

            // sign the transaction
            transaction.sign([wallet.payer]);

            // Execute the transaction
            const rawTransaction = transaction.serialize()
            const txid = await connection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
                maxRetries: 2
            });

            const result = await connection.confirmTransaction(txid);
            if (result.value.err != null) {
                customMessage += `\x1b[31mJupiter swap failed: \x1b[0m https://solscan.io/tx/${txid}\n`;
                customMessage += result.value.err + "\n";
                if (result.value.err.InstructionError && result.value.err.InstructionError[1] && result.value.err.InstructionError[1].Custom === 6001) {
                    customMessage += "\x1b[31mSlippage tolerance exceeded, retry! \x1b[0m \n";
                    return [false, customMessage];
                } else if (result.value.err.InstructionError && result.value.err.InstructionError[1] && result.value.err.InstructionError[1].Custom === 6035) {
                    customMessage += "\x1b[31mOracle confidence is too high, retry! \x1b[0m \n";
                    return [false, customMessage];
                } else if (result.value.err.InstructionError) {
                    customMessage += "\x1b[31mThis is fatal error, not worth to retry! \x1b[0m\n";
                    return [true, customMessage];
                }
            } else {
                customMessage += "\x1b[34mJupiter\x1b[0m \x1b[32mswap done \x1b[0m \n";
                customMessage += `https://solscan.io/tx/${txid}\n`;
            }
            return [result.value.err == null, customMessage];
        }
    } catch (error) {
        customMessage += "\x1b[31mJupiter swap exception: \x1b[0m \n";
        customMessage += error + "\n";
        if (error.InstructionError) {
            customMessage += "\x1b[31mThis is fatal error, not worth to retry! \x1b[0m \n";
            return [true, customMessage];
        }
        return [false, customMessage];
    }
}

async function verifyRequiredBalance(LP, data) {
    const tokenOutAmountInWallet = await getTokenAddressBalance(LP.tokenY.address);
    console.log("LP.tokenY.address", LP.tokenY.address);
    if (tokenOutAmountInWallet.uiAmount < transferAmountToUi(
        data.yTokenBoughtAmount,
        LP.tokenY.decimals
    )) {
        console.log("Required bought amount is not in wallet", data.yTokenBoughtAmount);
        console.log(tokenOutAmountInWallet);
        data.errorCounter++;
        if (data.errorCounter >= 3) {
            console.log("Error counter is more than 3, reset setting due to false error");
            data.state = 0;
            console.log(LP.data);
            //process.exit(1);
        }
        return false;
    } else {
        console.log("Required amount is in wallet");
        console.log(tokenOutAmountInWallet);
        console.log(LP.data);
        data.errorCounter = 0;
        return true;
    }
}

// create and call async main function
async function main(LP, fromInvariant) {
    LP.logMessage = '-----------------------------------------------------------------------------------------------------------------\n';
    LP.logMessage += "\x1b[97m[" + new Date().toISOString() + "] \x1b[0m \n";
    LP.logMessage += `\x1b[90mProcessing ${LP.JUPITER.onlyDirectRoutes === true ? 'onlyDirectRoutes' : ''} ${LP.tokenX.symbol} / ${LP.tokenY.symbol} with amount ${LP.tokenAmount} and fromInvariant ${fromInvariant} \x1b[0m \n`;

    try {
        if (fromInvariant) {
            if (LP.dataInvJup.state === 0) {
                LP.dataInvJup.xTokenInitialAmount = transferAmountToSolana(
                    LP.tokenAmount,
                    LP.tokenX.decimals
                );
                LP.dataInvJup.resultSimulateInvariant = await simulateInvariant(LP, fromInvariant, LP.dataInvJup, LP.dataInvJup.xTokenInitialAmount);
                if (LP.dataInvJup.resultSimulateInvariant === null) {
                    console.log(LP.logMessage);    
                    return false;
                }
                if (LP.dataInvJup.resultSimulateInvariant.accumulatedAmountIn == 0 || LP.dataInvJup.resultSimulateInvariant.accumulatedAmountOut == 0) {
                    LP.logMessage += LP.dataInvJup.resultSimulateInvariant.status + "\n";
                    console.log(LP.logMessage);    
                    return false;
                }
               LP.logMessage += `\x1b[34mInvarinat \x1b[0m => \x1b[33m ${transferAmountToUi(LP.dataInvJup.resultSimulateInvariant.accumulatedAmountIn.add(LP.dataInvJup.resultSimulateInvariant.accumulatedFee), LP.tokenX.decimals)} \x1b[0m \x1b[34m ${LP.tokenX.symbol} \x1b[0m => \x1b[33m ${transferAmountToUi(LP.dataInvJup.resultSimulateInvariant.accumulatedAmountOut, LP.tokenY.decimals)} \x1b[0m \x1b[34m${LP.tokenY.symbol}  \x1b[0m \n`;
                LP.dataInvJup.yTokenBoughtAmount = LP.dataInvJup.resultSimulateInvariant.accumulatedAmountOut;

                const resultSimulateJupiter = await simulateJupiter(LP.JUPITER.onlyDirectRoutes, LP.dataInvJup, LP.tokenY, LP.tokenX, new BN(LP.dataInvJup.yTokenBoughtAmount));
                LP.logMessage += resultSimulateJupiter[1];
                if (resultSimulateJupiter[0] === null) {
                    console.log(LP.logMessage);
                    return false;
                } else {
                    LP.dataInvJup.resultSimulateJupiter = resultSimulateJupiter[0];
                }
                LP.logMessage += `\x1b[34mJupiter \x1b[0m => \x1b[33m ${transferAmountToUi(LP.dataInvJup.resultSimulateJupiter.inAmount, LP.tokenY.decimals)} \x1b[0m \x1b[34m ${LP.tokenY.symbol}  \x1b[0m => \x1b[33m ${transferAmountToUi(LP.dataInvJup.resultSimulateJupiter.outAmount, LP.tokenX.decimals)} \x1b[0m \x1b[34m ${LP.tokenX.symbol}  \x1b[0m \n`;
            }

            const toOutAmount = new BN(LP.dataInvJup.resultSimulateJupiter.outAmount);
            LP.logMessage += `\x1b[90mfromInAmount:\x1b[0m \x1b[33m ${transferAmountToUi(LP.dataInvJup.xTokenInitialAmount, LP.tokenX.decimals)} \x1b[0m \n`;
            LP.logMessage += `\x1b[90mtoOutAmount:\x1b[0m \x1b[33m ${transferAmountToUi(toOutAmount, LP.tokenX.decimals)} \x1b[0m \n`;
            LP.logMessage += `\x1b[90mdiff:\x1b[0m \x1b[33m ${transferAmountToUi((toOutAmount - LP.dataInvJup.xTokenInitialAmount), LP.tokenX.decimals)} \x1b[0m \n`;

            if ((toOutAmount > LP.dataInvJup.xTokenInitialAmount) && ((toOutAmount - LP.dataInvJup.xTokenInitialAmount) > LP.minUnitProfit)) {

                 LP.logMessage += "\x1b[32mSwap out is bigger than swap in \x1b[0m \n";

                if (LP.dataInvJup.state === 0) {
                    const [resultInvariantSwap, resultJupiterSwap] = await Promise.all([swapInvariant(fromInvariant, LP.dataInvJup, LP.dataInvJup.xTokenInitialAmount),
                    swapJupiter(LP.dataInvJup.resultSimulateJupiter)]);
                    LP.logMessage += resultJupiterSwap[1];
                    LP.logMessage += resultInvariantSwap[1];
                    if (resultInvariantSwap[0] && resultJupiterSwap[0]) {
                        LP.dataInvJup.state = 0;
                        LP.tempLoopTimeout = 0;
                    } else if (!resultInvariantSwap[0] && resultJupiterSwap[0]) {
                        LP.dataInvJup.state = 1;
                    } else if (resultInvariantSwap[0] && !resultJupiterSwap[0]) {
                        LP.dataInvJup.state = 2;
                        LP.dataInvJup.errorCounter++;
                    }
                }

                if (LP.dataInvJup.state === 1) {
                    const resultInvariantSwap = await swapInvariant(fromInvariant, LP.dataInvJup, LP.dataInvJup.xTokenInitialAmount);
                    LP.logMessage += resultInvariantSwap[1];
                    if (resultInvariantSwap[0]) {
                        LP.dataInvJup.state = 0;
                    }
                } else if (LP.dataInvJup.state === 2) {
                    while (LP.dataInvJup.state === 2) {
                        const resultJupiterSwap = await swapJupiter(LP.dataInvJup.resultSimulateJupiter);
                        LP.logMessage += resultJupiterSwap[1];
                        if(resultJupiterSwap[0] === null) {
                            console.log(LP.logMessage);
                            return;
                        } else if (resultJupiterSwap[0]) {
                            LP.dataInvJup.errorCounter = 0;
                            LP.dataInvJup.state = 0;
                        } else {
                            LP.logMessage += "\x1b[31mError\x1b[0m counter is: " + LP.dataInvJup.errorCounter + "\n";
                            LP.dataInvJup.errorCounter++;
                            if (LP.dataInvJup.errorCounter > 3) {
                                LP.logMessage += "\x1b[31mError\x1b[0m counter is more than 3, reset and lets do new trade\n";
                                LP.dataInvJup.errorCounter = 0;
                                LP.dataInvJup.state = 0;
                            }
                        }
                    }
                }
                return true;
            } else {
                LP.logMessage += "\x1b[31mSwap in is bigger than swap out \x1b[0m \n";
                return false;
            }
        } else {
            if (LP.dataJupInv.state === 0) {
                LP.dataJupInv.xTokenInitialAmount = transferAmountToSolana(
                    LP.tokenAmount,
                    LP.tokenX.decimals
                );
                const resultSimulateJupiter = await simulateJupiter(LP.JUPITER.onlyDirectRoutes, LP.dataJupInv, LP.tokenX, LP.tokenY, new BN(LP.dataJupInv.xTokenInitialAmount));
                LP.logMessage += resultSimulateJupiter[1];
                if (resultSimulateJupiter[0] === null) {
                    console.log(LP.logMessage);
                    return false;
                } else {
                    LP.dataJupInv.resultSimulateJupiter = resultSimulateJupiter[0];
                }
                LP.logMessage += `\x1b[34mJupiter \x1b[0m => \x1b[33m ${transferAmountToUi(LP.dataJupInv.resultSimulateJupiter.inAmount, LP.tokenX.decimals)}  \x1b[0m \x1b[34m ${LP.tokenX.symbol} \x1b[0m => \x1b[33m ${transferAmountToUi(LP.dataJupInv.resultSimulateJupiter.outAmount, LP.tokenY.decimals)}  \x1b[0m \x1b[34m ${LP.tokenY.symbol} \x1b[0m \n`;

                LP.dataJupInv.yTokenBoughtAmount = new BN(LP.dataJupInv.resultSimulateJupiter.outAmount);

                LP.dataJupInv.resultSimulateInvariant = await simulateInvariant(LP, fromInvariant, LP.dataJupInv, LP.dataJupInv.yTokenBoughtAmount);
                if (LP.dataJupInv.resultSimulateInvariant === null) {
                    return false;
                }
                LP.logMessage += `\x1b[34mInvariant \x1b[0m => \x1b[33m ${transferAmountToUi(LP.dataJupInv.resultSimulateInvariant.accumulatedAmountIn, LP.tokenY.decimals)} \x1b[0m (fee:${transferAmountToUi(LP.dataJupInv.resultSimulateInvariant.accumulatedFee, LP.tokenY.decimals)}) \x1b[34m ${LP.tokenY.symbol}  \x1b[0m => \x1b[33m ${transferAmountToUi(LP.dataJupInv.resultSimulateInvariant.accumulatedAmountOut, LP.tokenX.decimals)}  \x1b[0m \x1b[34m ${LP.tokenX.symbol} \x1b[0m \n`;
            }

            const toOutAmount = Number(LP.dataJupInv.resultSimulateInvariant.accumulatedAmountOut);

            LP.logMessage += `\x1b[90mfromInAmount:\x1b[0m \x1b[33m ${transferAmountToUi(LP.dataJupInv.xTokenInitialAmount, LP.tokenX.decimals)} \x1b[0m \n`;
            LP.logMessage += `\x1b[90mtoOutAmount:\x1b[0m \x1b[33m ${transferAmountToUi(toOutAmount, LP.tokenX.decimals)} \x1b[0m \n`;
            LP.logMessage += `\x1b[90mdiff:\x1b[0m \x1b[33m ${transferAmountToUi((toOutAmount - LP.dataJupInv.xTokenInitialAmount), LP.tokenY.decimals)} \x1b[0m \n`;

            if ((toOutAmount > LP.dataJupInv.xTokenInitialAmount) && ((toOutAmount - LP.dataJupInv.xTokenInitialAmount) > LP.minUnitProfit)) {

                 LP.logMessage += "\x1b[32mSwap out is bigger than swap in \x1b[0m \n";
                if (LP.dataJupInv.state === 0) {
                    const [resultJupiterSwap, resultInvariantSwap] = await Promise.all([swapJupiter(LP.dataJupInv.resultSimulateJupiter),
                    swapInvariant(fromInvariant, LP.dataJupInv, LP.dataJupInv.yTokenBoughtAmount)]);
                    LP.logMessage += resultJupiterSwap[1];
                    LP.logMessage += resultInvariantSwap[1];
                    if (resultJupiterSwap[0] && resultInvariantSwap[0]) {
                        LP.dataJupInv.state = 0;
                        LP.tempLoopTimeout = 0;
                    } else if (!resultJupiterSwap[0] && resultInvariantSwap[0]) {
                        LP.dataJupInv.state = 1;
                        LP.dataJupInv.errorCounter++;
                    } else if (resultJupiterSwap[0] && !resultInvariantSwap[0]) {
                        LP.dataJupInv.state = 2
                    }
                }

                if (LP.dataJupInv.state === 1) {
                    while (LP.dataJupInv.state === 1) {
                        const resultJupiterSwap = await swapJupiter(LP.dataJupInv.resultSimulateJupiter);
                        LP.logMessage += resultJupiterSwap[1];
                        if (resultJupiterSwap[0]) {
                            LP.dataJupInv.errorCounter = 0;
                            LP.dataJupInv.state = 0;
                        } else {
                            LP.dataJupInv.errorCounter++;
                            LP.logMessage += "\x1b[31mError\x1b[0m counter is: " + LP.dataJupInv.errorCounter + "\n";
                            if (LP.dataJupInv.errorCounter > 3) {
                                LP.logMessage += "Error counter is more than 3, reset and lets do new trade\n";
                                LP.dataJupInv.errorCounter = 0;
                                LP.dataJupInv.state = 0;
                            }
                        }
                    }
                } else if (LP.dataJupInv.state === 2) {
                    const resultInvariantSwap = await swapInvariant(fromInvariant, LP.dataJupInv, LP.dataJupInv.yTokenBoughtAmount);
                    LP.logMessage += resultInvariantSwap[1];
                    if (resultInvariantSwap[0]) {
                        LP.dataJupInv.state = 0;
                    }
                }
                return true;
            } else {
                LP.logMessage += "\x1b[31mSwap in is bigger than swap out \x1b[0m \n";
                return false;
            }
        }
    } catch (error) {
        LP.logMessage += error + "\n";
    }
}

async function begin() {
    let finalLPs = [];
    // If index of config is set, run only that config. Else run all configs
    if (indexOfLP >= 0 && indexOfLP < LPs.length) {
        finalLPs = LPs.slice(indexOfLP, indexOfLP + 1);
        console.log(`Running configuration for LP at index ${indexOfLP} only.`);
    } else {
        finalLPs = LPs;
        console.log("LPs in config:", finalLPs.length);
    }
    // If running true, do job else return and finish
    while (running) {
        // Loop through all settings
        for (const LP of finalLPs) {
            // Call main function.
            // fromInvariant:
            // TRUE = buy on invariant and sell on jupiter
            // FALSE = buy on jupiter and sell on invariant

            if (LP.fromInvariant) {
                const swapped = await main(LP, true);
                //If no swap executed fromInvariant toJupiter, try swap fromJupiter toInvariant
                if (!swapped) {
                    LP.fromInvariant = false;
                }
            } else {
                const swapped = await main(LP, false);
                //If no swapp executed fromJupiter to Invariant, try swap fromInvariant toJupiter
                if (!swapped) {
                    LP.fromInvariant = true;
                }
            }
            console.log(LP.logMessage);
        }
    }
}
  
begin();