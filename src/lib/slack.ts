import { createRetryFetch } from './fetchRetry.js';

const fetch = createRetryFetch({ retries: 3, timeoutMs: 10000 });

interface SlackConfig {
  enabled: boolean;
  token: string;
  channel: string;
}

export interface ChunkInfo {
  chunkFileName: string;
  currentChunkNumber: number;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  collectionProgress?: {
    totalCollections: number;
    collectionsWithProgress: number;
    pinnedCollections: number;
    largestCollection?: {
      name: string;
      currentPage: number;
      lastPage?: number;
      assetsProcessed?: number;
      completed?: number;
      failed?: number;
    };
    pinningCollections?: Array<{
      name: string;
      currentPage: number;
      assetsProcessed: number;
      completed: number;
      failed: number;
    }>;
  };
}

interface JobResults {
  success: boolean;
  totalHashesFound: number;
  pinsExecuted: number;
  alreadyPinned: number;
  missingHashes: number;
  notMissingFromIPFS: number;
  duplicatesAvoided: number;
  runtime: string;
  isDryRun: boolean;
  error?: string;
  chunkInfo?: ChunkInfo; // Add chunk information
  apiFailures?: {
    atomicAssets: number;
    pinataList: number;
    pinataPin: number;
    hashVerification: number;
    total: number;
  };
}

// Get Slack configuration from environment
function getSlackConfig(): SlackConfig {
  const token = process.env.SLACK_TOKEN || '';
  const channel = process.env.SLACK_CHANNEL || '';

  const enabled = Boolean(token && channel);

  return {
    enabled,
    token,
    channel,
  };
}

// Format results into Slack message
function formatSlackMessage(
  results: JobResults,
  isStartNotification: boolean = false
): any {
  const {
    success,
    totalHashesFound,
    pinsExecuted,
    alreadyPinned,
    missingHashes,
    notMissingFromIPFS,
    duplicatesAvoided,
    runtime,
    isDryRun,
    error,
    chunkInfo,
    apiFailures,
  } = results;

  const emoji = success ? '✅' : '❌';
  const status = success ? 'COMPLETED' : 'FAILED';
  const mode = isDryRun ? 'DRY RUN ANALYSIS' : 'PINNING JOB';

  // Include chunk information in the main message if available
  let text = `${emoji} WAX IPFS ${mode} ${status}`;
  if (chunkInfo) {
    text += ` - Chunk ${chunkInfo.currentChunkNumber}/${chunkInfo.totalChunks}`;
  }

  const fields = [];

  // Add chunk progress information as the first field if available
  if (chunkInfo) {
    const overallProgress = Math.round(
      ((chunkInfo.completedChunks + 1) / chunkInfo.totalChunks) * 100
    );
    const remainingChunks =
      chunkInfo.totalChunks -
      chunkInfo.completedChunks -
      chunkInfo.failedChunks;

    let chunkStatusValue = `📄 Current: ${chunkInfo.chunkFileName}\n`;
    chunkStatusValue += `✅ Completed: ${chunkInfo.completedChunks}/${chunkInfo.totalChunks}\n`;
    if (chunkInfo.failedChunks > 0) {
      chunkStatusValue += `❌ Failed: ${chunkInfo.failedChunks}\n`;
    }
    if (remainingChunks > 0) {
      chunkStatusValue += `⏳ Remaining: ${remainingChunks}\n`;
    }
    chunkStatusValue += `📊 Overall Progress: ${overallProgress}%`;

    fields.push({
      title: '📦 Auto-Chunk Progress',
      value: chunkStatusValue,
      short: false,
    });

    // Add detailed collection progress if available
    if (chunkInfo.collectionProgress) {
      const { totalCollections, pinnedCollections, pinningCollections } =
        chunkInfo.collectionProgress;

      let collectionStatusValue = '';

      // Show summary
      collectionStatusValue += `📚 Total: ${totalCollections} collections\n`;
      collectionStatusValue += `✅ Completed: ${pinnedCollections} collections\n`;

      // Show collections in progress with their page numbers
      if (pinningCollections && pinningCollections.length > 0) {
        collectionStatusValue += `\n🔄 In Progress:\n`;

        // Sort by page number descending to show most progress first
        const sortedCollections = pinningCollections.sort(
          (a, b) => b.currentPage - a.currentPage
        );

        // Show up to 5 collections with most progress
        const collectionsToShow = sortedCollections.slice(0, 5);

        for (const col of collectionsToShow) {
          collectionStatusValue += `• ${col.name}: Page ${col.currentPage}`;
          if (col.assetsProcessed > 0) {
            collectionStatusValue += ` (${col.assetsProcessed} assets)`;
          }
          if (col.completed > 0 || col.failed > 0) {
            collectionStatusValue += ` - ✅${col.completed}`;
            if (col.failed > 0) {
              collectionStatusValue += ` ❌${col.failed}`;
            }
          }
          collectionStatusValue += '\n';
        }

        if (sortedCollections.length > 5) {
          collectionStatusValue += `• ... and ${sortedCollections.length - 5} more collections\n`;
        }
      }

      fields.push({
        title: '📖 Collection Progress',
        value: collectionStatusValue,
        short: false,
      });
    }
  }

  if (success) {
    fields.push({
      title: '📊 Hash Discovery',
      value: `${totalHashesFound} total hashes found`,
      short: true,
    });

    fields.push({
      title: isDryRun ? '📋 Would Execute' : '✅ Pins Executed',
      value: `${pinsExecuted} pin requests`,
      short: true,
    });

    if (alreadyPinned > 0) {
      fields.push({
        title: '⏭️ Already Pinned',
        value: `${alreadyPinned} skipped`,
        short: true,
      });
    }

    if (notMissingFromIPFS > 0) {
      fields.push({
        title: '✅ Not Missing from IPFS',
        value: `${notMissingFromIPFS} hashes available`,
        short: true,
      });
    }

    if (missingHashes > 0) {
      fields.push({
        title: '❌ Missing from IPFS',
        value: `${missingHashes} hashes not found`,
        short: true,
      });
    }

    if (duplicatesAvoided > 0) {
      fields.push({
        title: '💰 Cost Savings',
        value: `${duplicatesAvoided + alreadyPinned} pins avoided`,
        short: true,
      });
    }

    fields.push({
      title: '⏱️ Runtime',
      value: runtime,
      short: true,
    });

    // Add API failure information if present
    if (apiFailures && apiFailures.total > 0) {
      let failureDetails = `${apiFailures.total} total failures`;
      const breakdown = [];
      if (apiFailures.atomicAssets > 0)
        breakdown.push(`AtomicAssets: ${apiFailures.atomicAssets}`);
      if (apiFailures.pinataList > 0)
        breakdown.push(`IPFS List: ${apiFailures.pinataList}`);
      if (apiFailures.pinataPin > 0)
        breakdown.push(`IPFS Pin: ${apiFailures.pinataPin}`);
      if (apiFailures.hashVerification > 0)
        breakdown.push(`Hash Verification: ${apiFailures.hashVerification}`);

      if (breakdown.length > 0) {
        failureDetails += `\n(${breakdown.join(', ')})`;
      }

      fields.push({
        title: '⚠️ API Failures',
        value: failureDetails,
        short: false,
      });
    }
  } else if (error) {
    fields.push({
      title: '❌ Error Details',
      value: error,
      short: false,
    });
  }

  return {
    text,
    attachments: [
      {
        color: success ? 'good' : 'danger',
        fields,
        footer: 'WAX IPFS Pinning Service',
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };
}

// Send notification via Slack API
async function sendSlackAPI(
  token: string,
  channel: string,
  message: any
): Promise<void> {
  try {
    const payload = {
      channel,
      ...message,
    };

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.ok) {
      throw new Error(`Slack API Error: ${result.error}`);
    }

    console.log(`📢 Slack notification sent to #${channel}`);
  } catch (error: any) {
    console.error(`⚠️  Failed to send Slack notification:`, error.message);
  }
}

// Send simple text notification
export async function sendSlackStartNotification(
  isDryRun: boolean,
  chunkInfo?: ChunkInfo
): Promise<void> {
  const config = getSlackConfig();

  if (!config.enabled) {
    console.log(
      `📵 Slack notifications disabled - no token/channel configured`
    );
    return;
  }

  const mode = isDryRun ? 'DRY RUN ANALYSIS' : 'PINNING JOB';

  // Include chunk information in the main message if available
  let text = `🚀 WAX IPFS ${mode} STARTED`;
  if (chunkInfo) {
    text += ` - Chunk ${chunkInfo.currentChunkNumber}/${chunkInfo.totalChunks}`;
  }

  const fields = [];

  // Add chunk progress information if available
  if (chunkInfo) {
    const overallProgress = Math.round(
      (chunkInfo.completedChunks / chunkInfo.totalChunks) * 100
    );
    const remainingChunks =
      chunkInfo.totalChunks -
      chunkInfo.completedChunks -
      chunkInfo.failedChunks;

    let chunkStatusValue = `📄 Current: ${chunkInfo.chunkFileName}\n`;
    chunkStatusValue += `✅ Completed: ${chunkInfo.completedChunks}/${chunkInfo.totalChunks}\n`;
    if (chunkInfo.failedChunks > 0) {
      chunkStatusValue += `❌ Failed: ${chunkInfo.failedChunks}\n`;
    }
    if (remainingChunks > 0) {
      chunkStatusValue += `⏳ Remaining: ${remainingChunks}\n`;
    }
    chunkStatusValue += `📊 Overall Progress: ${overallProgress}%`;

    fields.push({
      title: '📦 Auto-Chunk Progress',
      value: chunkStatusValue,
      short: false,
    });

    // Add collection progress details for start notification
    if (chunkInfo.collectionProgress) {
      const { totalCollections, pinnedCollections, pinningCollections } =
        chunkInfo.collectionProgress;

      let collectionStatusValue = '';

      // Show summary
      collectionStatusValue += `📚 Total: ${totalCollections} collections\n`;
      if (pinnedCollections > 0) {
        collectionStatusValue += `✅ Already Completed: ${pinnedCollections} collections\n`;
      }

      // Show collections that will be resumed with their current page
      if (pinningCollections && pinningCollections.length > 0) {
        collectionStatusValue += `\n🔄 Resuming:\n`;

        // Sort by page number descending to show most progress first
        const sortedCollections = pinningCollections.sort(
          (a, b) => b.currentPage - a.currentPage
        );

        // Show up to 3 collections being resumed
        const collectionsToShow = sortedCollections.slice(0, 3);

        for (const col of collectionsToShow) {
          collectionStatusValue += `• ${col.name}: From page ${col.currentPage}`;
          if (col.assetsProcessed > 0) {
            collectionStatusValue += ` (${col.assetsProcessed} assets processed)`;
          }
          collectionStatusValue += '\n';
        }

        if (sortedCollections.length > 3) {
          collectionStatusValue += `• ... and ${sortedCollections.length - 3} more collections\n`;
        }
      }

      fields.push({
        title: '📖 Collection Status',
        value: collectionStatusValue,
        short: false,
      });
    }
  }

  fields.push({
    title: 'Status',
    value: 'Job initialization complete, processing starting...',
    short: false,
  });

  const message = {
    text,
    attachments: [
      {
        color: 'warning',
        fields,
        footer: 'WAX IPFS Pinning Service',
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };

  console.log(`📤 Sending Slack start notification to #${config.channel}...`);
  await sendSlackAPI(config.token, config.channel, message);
}

// Main function to send Slack notifications
export async function sendSlackNotification(
  results: JobResults
): Promise<void> {
  const config = getSlackConfig();

  if (!config.enabled) {
    console.log(
      `📵 Slack notifications disabled - no token/channel configured`
    );
    return;
  }

  const message = formatSlackMessage(results);
  console.log(`📤 Sending Slack notification to #${config.channel}...`);
  await sendSlackAPI(config.token, config.channel, message);
}
