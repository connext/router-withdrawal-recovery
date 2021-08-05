import axios from "axios";
import { constants, providers } from "ethers";
import { config as dotEnvConfig } from "dotenv";
import {
  HANDLED_CHAINS,
  ROUTER_IDENTIFIER,
  BASE_URL,
  HANDLED_OPTIONS,
  RETRY_PARITY,
  TARGET,
  STATUS,
} from "./constants";
import { FlaggedTransfer, TransferData } from "./types";
import { sendQuery, QUERY } from "./query";
import {
  saveJsonFile,
  makeOutputDir,
  parseStuckTransfersQuery,
  getOnchainBalance,
} from "./utils";
import { Values, WithdrawCommitmentJson } from "@connext/vector-types";

dotEnvConfig();
// console.log("config: ", process.env);

// All transfers that have been flagged for review due to errors.
// Includes transfers that will need to be disputed, etc. Saved to file at end of each
// iteration.
let flaggedTransfers: FlaggedTransfer[] = [];
let singleSignedTransfers: FlaggedTransfer[] = [];

// TODO:
// let rescuedFunds: { [chain: string]: number };

const logAxiosError = (error: any) => {
  if (error.response) {
    // The request was made and the server responded with a status code
    // that falls out of the range of 2xx
    console.log(error.response.data);
    console.log(error.response.status);
    console.log(error.response.headers);
  } else if (error.request) {
    // The request was made but no response was received
    // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
    // http.ClientRequest in node.js
    console.log(error.request);
  } else {
    // Something happened in setting up the request that triggered an Error
    console.log("Error", error.message);
  }
  console.log(error.config);
};

const retrieveStuckTransfers = async (
  chainId: number,
  target: Values<typeof TARGET>,
  status: Values<typeof STATUS>
): Promise<TransferData[]> => {
  console.log(
    `Retrieving stuck transfers for ${target}, ${status}, on chain ${chainId}`
  );
  const query = QUERY[target][status](chainId);
  const response = await sendQuery(query);
  return parseStuckTransfersQuery(response);
};

const retryWithdrawal = async (
  channelAddress: string,
  transferId: string,
  provider: providers.JsonRpcProvider
) => {
  let commitment: WithdrawCommitmentJson;

  try {
    const res = await axios.get(
      `${BASE_URL}/${ROUTER_IDENTIFIER}/withdraw/transfer/${transferId}`
    );
    commitment = res.data;
  } catch (e) {
    console.log("Error fetching transfer", transferId);
    logAxiosError(e);
    return;
  }
  console.log(
    `Checking withdrawal: ${transferId} for channel ${commitment.channelAddress}`
  );

  let receipt: providers.TransactionReceipt | undefined = undefined;
  if (commitment.transactionHash) {
    console.log(
      "Commitment has existing transaction hash",
      commitment.transactionHash
    );
    if (commitment.transactionHash === constants.HashZero) {
      return;
    }
    // receipt = await provider.getTransactionReceipt(commitment.transactionHash);
    // if (receipt) {
    //   console.log("Tx receipt available", transferId);
    // }
  } else {
    console.log("Commitment missing hash");
  }

  // Check if the commitment is single signed
  if (!commitment.aliceSignature || !commitment.bobSignature) {
    console.log("Flagging single-signed withdrawal.");
    singleSignedTransfers.push({
      transactionHash: commitment.transactionHash,
      channelAddress: commitment.channelAddress,
      transferId,
      receipt,
      error: "Withdrawal commitment single-signed",
    });
    return;
  }

  // Check the no-op case
  const balance = await getOnchainBalance(
    commitment.assetId,
    channelAddress,
    provider
  );
  if (balance.isZero() && commitment.callTo === constants.AddressZero) {
    console.log(`Withdraw no-op`);
    return;
  }

  console.log(
    `Reattempting withdrawal: ${transferId} for channel ${commitment.channelAddress}`
  );
  try {
    const res = await axios.post(`${BASE_URL}/withdraw/retry`, {
      publicIdentifier: ROUTER_IDENTIFIER,
      channelAddress,
      transferId,
    });
    console.log(`Retried transfer: `, {
      ...res.data,
      channelAddress: commitment.channelAddress,
    });
  } catch (error) {
    console.log(`Error on transfer: ${transferId}`);
    if (
      error.response.data.message.includes(
        "Withdrawal commitment single-signed"
      )
    ) {
      console.log("Flagging single-signed withdrawal.");
      singleSignedTransfers.push({
        transactionHash: commitment.transactionHash,
        channelAddress: commitment.channelAddress,
        transferId,
        receipt,
        error,
      });
    } else if (
      error.response.data.message.includes("Withdrawal transaction found")
    ) {
      // TODO: Handle this case: we need to update DB / offchain state.
      console.log("Withdrawal transaction found.");
      return;
    } else {
      console.log(`Flagging transfer for error ${error.response.data.message}`);
      flaggedTransfers.push({
        transactionHash: commitment.transactionHash,
        channelAddress: commitment.channelAddress,
        transferId,
        receipt,
        error,
      });
    }
    logAxiosError(error);
  }
};

/// Helper for dumping flagged transfer info into a json file.
const saveFlaggedTransfers = async (forCase: string) => {
  if (flaggedTransfers.length === 0 && singleSignedTransfers.length === 0) {
    console.log("No transfers were flagged, nothing to save.");
    return;
  }
  console.log("Saving flagged transfers...");
  makeOutputDir();
  // Convert lists to a JSON string and write file to local disk in output directory.
  if (flaggedTransfers.length > 0) {
    console.log("flagged:", flaggedTransfers);
    saveJsonFile(`errors-${forCase}`, flaggedTransfers);
  }
  if (singleSignedTransfers.length > 0) {
    console.log("single signed:", singleSignedTransfers);
    saveJsonFile(`singlesigned-${forCase}`, singleSignedTransfers);
  }

  // Clear flagged transfers.
  flaggedTransfers = [];
  singleSignedTransfers = [];
};

const handleRetries = async (
  transfers: TransferData[],
  provider: providers.JsonRpcProvider,
  chainName: string,
  target: Values<typeof TARGET>,
  status: Values<typeof STATUS>
) => {
  // Retrieve all the stuck transfers related to this
  const executionName = [chainName, status, target].join(".");
  const mark = Date.now();
  console.log(`\nSTART: ${executionName}`);
  let count = 1;
  for (let transfer of transfers) {
    console.log(`\n${count} / ${transfers.length}`);
    count += 1;
    try {
      await retryWithdrawal(
        transfer.channelAddress,
        transfer.transferId,
        provider
      );
    } catch (e) {
      console.error("retryWithdrawal Error:", e);
    }
    await new Promise<void>((res) => setTimeout(() => res(), RETRY_PARITY));
  }
  saveFlaggedTransfers(executionName);
  console.log(
    `\nFINISHED: ${executionName}. Execution time ${Date.now() - mark}ms.`
  );
};

// "/:publicIdentifier/withdraw/transfer/:transferId"
const run = async () => {
  // First pull all data up front for all chains
  // do serially for better logging

  // transfers[chainId][option.target][option.status]
  const transfers = {};
  for (const chainName of Object.keys(HANDLED_CHAINS)) {
    const chainId = HANDLED_CHAINS[chainName];
    let chainTotal = 0;
    for (const option of HANDLED_OPTIONS) {
      const retrieved = await retrieveStuckTransfers(
        chainId,
        option.target,
        option.status
      );
      transfers[chainId][option.target][option.status] = retrieved;
      chainTotal += retrieved.length;
    }
    console.log(`------------------`);
    console.log(`Completed retrieval for all options`);
    console.log(`Retrieved ${chainTotal} stuck transfers on ${chainName}`);
    console.log(`------------------`);
  }

  // Handle the retries for all chains
  await Promise.all(
    Object.keys(HANDLED_CHAINS).map(async (chainName) => {
      const envVar = `${chainName.toUpperCase}_PROVIDER_URL`;
      const provider = new providers.JsonRpcProvider(process.env[envVar]);
      for (let option of HANDLED_OPTIONS) {
        await handleRetries(
          transfers[option.target][option.status] ?? [],
          provider,
          chainName,
          option.target,
          option.status
        );
      }
    })
  );
  // for (let chainName of Object.keys(HANDLED_CHAINS)) {
  //   const envVar = `${chainName.toUpperCase}_PROVIDER_URL`;
  //   const provider = new providers.JsonRpcProvider(process.env[envVar]);
  //   const chainId = HANDLED_CHAINS[chainName];
  //   for (let option of HANDLED_OPTIONS) {
  //     await handleRetries(
  //       provider,
  //       chainName,
  //       chainId,
  //       option.target,
  //       option.status
  //     );
  //   }
  // }
};

run();
