import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const applicationRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// A future desktop launcher supplies FLIGHT_DECK_DATA_DIR. Keeping `data/` as
// the development default preserves existing local installations and prevents
// the app bundle itself from becoming a mutable data store.
export const dataDir = path.resolve(
  process.env.FLIGHT_DECK_DATA_DIR || path.join(applicationRoot, "data"),
);
export const databaseFile = path.join(dataDir, "flight-deck.sqlite");
export const initializationFile = path.join(dataDir, "initialization.json");
export const knowledgeIndexVersion = 1;

function readInitialization() {
  try {
    return JSON.parse(readFileSync(initializationFile, "utf8"));
  } catch {
    return null;
  }
}

export function initializeAppStorage() {
  const hadDataDirectory = existsSync(dataDir);
  const previous = readInitialization();
  mkdirSync(dataDir, { recursive: true });
  return {
    dataDir,
    databaseFile,
    firstRun: (!hadDataDirectory || !existsSync(databaseFile)) && !previous,
    needsKnowledgeIndex:
      !previous || previous.knowledgeIndexVersion !== knowledgeIndexVersion,
    initializedAt: previous?.initializedAt || null,
  };
}

export function completeInitialization({ firstRun = false } = {}) {
  const previous = readInitialization() || {};
  const state = {
    schemaVersion: 1,
    knowledgeIndexVersion,
    initializedAt: previous.initializedAt || new Date().toISOString(),
    lastCompletedAt: new Date().toISOString(),
    firstRunCompleted: previous.firstRunCompleted || Boolean(firstRun),
  };
  writeFileSync(initializationFile, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function storageStatus() {
  const state = readInitialization();
  return {
    dataDir,
    databaseFile,
    initialized: Boolean(state?.initializedAt),
    initializedAt: state?.initializedAt || null,
    knowledgeIndexVersion: state?.knowledgeIndexVersion || 0,
  };
}
