import { IExtensionContext, IDiscoveryResult, IGame, IState, ISupportedResult, ProgressDelegate, IInstallResult, IExtensionApi, IProfile, ThunkStore, IDeployedFile, IInstruction, ILink, IMod, IDialogResult } from 'vortex-api/lib/types/api';

// @ts-check
import Promise = require('bluebird');
import path = require('path');
import hjson = require('hjson');
import { fs, log, util, selectors, actions } from 'vortex-api';
import winapi = require('winapi-bindings');
import semver = require('semver');
import updates = require('./updates')
import { concatVersionObject } from './updates';
import { readModMetadata } from './modMetadataReader';

export const GAME_ID = 'starsector';
export const MOD_INFO_FILE = "mod_info.json"
export const VERSION_CHECKER_FILE_EXT = ".version"
export const MOD_FOLDER_LOCATION = "mods"

///////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Debug flag
// - Always migrate on boot
// - Display debug context menu options 
const debugMode = false

// Adapted from https://stackoverflow.com/a/24518413/1622788
// Removes '#'s, which are used as comments by the game's json parser
const COMMENT_STRIPPING_REGEX = /((["'])(?:\\[\s\S]|.)*?\2|\#(?![*\#])(?:\\.|\[(?:\\.|.)\]|.)*?\#)|\#.*?$|\#\*[\s\S]*?\*\#/gm;

export const STARSECTOR_FORUM_URL = 'https://fractalsoftworks.com/forum/index.php'

/**
 * @returns {string | Promise<String>}
 */
function findGame(): string | Promise<string> {
  try {
    const instPath = winapi.RegGetValue(
      'HKEY_CURRENT_USER',
      'Software\\Fractal Softworks\\Starsector',
      '');
    if (!instPath) {
      throw new Error('Starsector registry key not found!');
    }
    return Promise.resolve(instPath.value);
  } catch (err) {
    return Promise.reject(err);
  }
}

function testSupportedContent(files: string[], gameId: string) {
  if (gameId !== GAME_ID) {
    return Promise.resolve({ supported: false });
  }

  const contentPath = files.find(file => path.basename(file) === MOD_INFO_FILE);
  return Promise.resolve({
    supported: contentPath !== undefined,
    requiredFiles: [contentPath],
  });
}

/**
 * Strip '#' comments using regex, then parse using relaxed-json
 */
export function parseJson(json: string) {
  return hjson.parse(json.replace(COMMENT_STRIPPING_REGEX, "$1"));
}

async function installContent(
  contextApi: IExtensionApi,
  files: string[],
  destinationPath: string,
  gameId: string,
  progressDelegate: ProgressDelegate) {
  const modInfoFile = files.find(file => path.basename(file) === MOD_INFO_FILE);
  const basePath = path.dirname(modInfoFile);

  let outputPath = "";
  if (modInfoFile.indexOf(MOD_INFO_FILE) > 0) {
    outputPath = path.basename(path.dirname(modInfoFile))
  } else {
    return Promise.reject(
      new util.DataInvalid(`${MOD_INFO_FILE} not found in a folder. The mod may be incorrectly packaged`));
  }

  let absoluteFiles = files.map((relativeFile) => path.join(destinationPath, relativeFile))

  return readModMetadata(contextApi, absoluteFiles)
    .then((attributes: Map<string, string>) => {
      const attrInstructions = [];

      attributes.forEach((key: string, value: string) => {
        attrInstructions.push({
          type: 'attribute',
          key: key,
          value: value
        });
      })

      return Promise.resolve(attrInstructions);
    })
    .then(attrInstructions => {
      let instructions = attrInstructions.concat(files.filter(file =>
        file.startsWith(basePath + path.sep) && !file.endsWith(path.sep))
        .map(file => ({
          type: 'copy',
          source: file,
          destination: path.join(outputPath, file.substring(basePath.length + 1))
        })));
      return { instructions };
    });
}

// From https://github.com/Nexus-Mods/vortex-games/blob/296abf250fdc1c57314791e704d14a5165695dec/game-bladeandsorcery/index.js#L403
function migrateFrom_1_2_2(api, oldVersion) {
  if (semver.gt(oldVersion, '1.2.2') && !debugMode) {
    return Promise.resolve();
  }

  const state = api.store.getState();
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  const modKeys: string[] = Object.keys(mods);

  if (modKeys.length === 0) {
    return Promise.resolve();
  }

  const activatorId = util.getSafe(state, ['settings', 'mods', 'activator', GAME_ID], undefined);
  const gameDiscovery =
    util.getSafe(state, ['settings', 'gameMode', 'discovered', GAME_ID], undefined);

  if ((gameDiscovery?.path === undefined)
    || (activatorId === undefined)) {
    // if this game is not discovered or deployed there is no need to migrate
    log('debug', 'skipping starsector migration because no deployment set up for it');
    return Promise.resolve();
  }

  // Holds mod ids of mods we failed to migrate.
  let failedToMigrate = [];

  const deployTarget = path.join(gameDiscovery.path, MOD_FOLDER_LOCATION);
  const stagingFolder = selectors.installPathForGame(state, GAME_ID);
  const nonNexusMods: IMod[] = modKeys.filter(key => mods[key].source !== 'nexus')
    .map(key => mods[key]);

  return api.awaitUI()
    .then(() => Promise.each(nonNexusMods, (mod: IMod) => {
      const modPath = path.join(stagingFolder, mod.installationPath);
      let files = [];
      return util.walk(modPath, entries => {
        files = files.concat(entries);
      })
        .then(() => readModMetadata(api, files)
          .catch(e => {
            console.log(e)
            failedToMigrate.push(mod.archiveId + '\n' + e)
          }))
        .then(attributes => {
          if (attributes) {
            for (let [key, value] of Object.entries(attributes)) {
              api.store.dispatch(actions.setModAttribute(GAME_ID, mod.id, key, value));
            }
          }
        })
    }))
    .finally(() => {
      if (failedToMigrate.length > 0) {
        api.sendNotification({
          type: 'warning',
          message: 'Failed to migrate mods',
          actions: [
            {
              title: 'More', action: (dismiss) =>
                api.showDialog('info', 'Mods failed migration', {
                  text: api.translate('Some mods failed to migrate to an updated format.\n\n'
                    + '{{modIds}}',
                    { replace: { modIds: failedToMigrate.join('\n') } })
                }, [{ label: 'Close', action: () => dismiss() }])
            },
          ],
        });
      } else {
        // api.store.dispatch(actions.setDeploymentNecessary(GAME_ID, true));
      }
    });
}

/**
 * @param {import('vortex-api/lib/types/api').IExtensionContext} context
 */
function main(context: IExtensionContext) {
  context.registerGame({
    id: GAME_ID,
    name: 'Starsector',
    mergeMods: true,
    queryPath: findGame,
    queryModPath: () => MOD_FOLDER_LOCATION,
    logo: 'gameart.jpg',
    executable: () => 'starsector.exe',
    requiredFiles: [
      'starsector.exe',
    ]
  });

  context.registerMigration(old => migrateFrom_1_2_2(context.api, old));

  context.once(() => {
    util.installIconSet(GAME_ID, path.join(__dirname, 'icons.svg'));
    setupUpdates(context.api)
    context.api.events.on('open-mod-page', openStarsectorModPage(context.api));
  });

  context.registerInstaller(
    'starsector',
    50,
    testSupportedContent,
    (files, destination, gameId, progress) => installContent(context.api, files, destination, gameId, progress));

  // Based on https://github.com/Nexus-Mods/Vortex/blob/fc439bda319430b0891151db2d6505ab79128872/src/extensions/nexus_integration/index.tsx#L804
  context.registerAction('mods-action-icons', 900, 'nexus', {}, 'Open on Starsector Forums',
    instanceIds => {
      const state = context.api.store.getState();

      if (!isVortexInStarsectorMode(context)) {
        return false;
      }

      const forumThreadId = getModAttribute(context, instanceIds, 'forumThreadId')
      const error = getModAttribute(context, instanceIds, 'forumThreadIdError')

      if (forumThreadId != undefined) {
        log('info', 'Opening mod forum id ' + forumThreadId, {});

        // Based on https://github.com/Nexus-Mods/Vortex/blob/063c53fc220beb95ccc1e49ef33174f1443f2e69/src/extensions/nexus_integration/eventHandlers.ts#L142
        util.opn(getModForumThreadPage(forumThreadId))
          .catch(err => undefined);
        return true;
      } else if (error != null) {
        context.api.showErrorNotification(error, {});
      } else {
        return false;
      }
    },
    instanceIds => {
      return isVortexInStarsectorMode(context) &&
        getModAttribute(context, instanceIds, 'forumThreadId') != null;
    });

  if (debugMode) {
    context.registerAction('mods-action-icons', 900, 'nexus', {}, 'Migrate Mods',
      instanceIds => {
        if (!isVortexInStarsectorMode(context)) {
          return false;
        }

        migrateFrom_1_2_2(context.api, "1.0.0")
      },
      instanceIds => {
        return isVortexInStarsectorMode(context);
      });
  }

  context.registerModSource('starsectorforum', 'Starsector Forum', () => {
    // if you want to show an in-Vortex browser
    //context.api.store.dispatch(actions.showURL('URL TO SHOW HERE'));
    // if you want to open it externally
    util.opn(STARSECTOR_FORUM_URL).catch(err => undefined);
  },
    {
      condition: () => {
        //If this game is supported and marked enabled, we can show the button.
        const activeGameId = selectors.activeGameId(context.api.store.getState());
        return (activeGameId === GAME_ID);
      },
      icon: 'choose an icon'
    }
  );

  return true;
}

/**
 * A simple handler to register the events used for checking mod updates
 * 
 * @param api The extension API
 */
function setupUpdates(api: IExtensionApi) {
  log('debug', 'starsector: initialising update handlers');
  const checkForUpdates = async (gameId, mods: { [id: string]: IMod }) => {
    log('info', 'attempting starsector update check', { modCount: Object.keys(mods).length, game: gameId });
    await updates.checkForStarsectorModsUpdates(api, gameId, mods);
    return Promise.resolve();
  };
  // const installUpdates = async (gameId: string, modId: string) => {
  //     log('info', 'attempting starsector mod update', { modId });
  //     await installBeatModsUpdate(api, gameId, modId);
  //     return Promise.resolve();
  // };
  api.events.on('check-mods-version', checkForUpdates);
  // api.events.on('mod-update', installUpdates);
}

function getModAttribute(context, instanceIds, attrKey) {
  const state = context.api.store.getState();
  const mod = getSafe(state.persistent.mods, [GAME_ID, instanceIds[0]], undefined);

  if (mod != undefined) {
    return mod.attributes[attrKey];
  } else {
    return null;
  }
}

function isVortexInStarsectorMode(context) {
  const state = context.api.getState();
  const gameMode = selectors.activeGameId(state);
  return (gameMode === GAME_ID);
}

function getSafe(state, path, fallback) {
  let current = state;
  for (const segment of path) {
    if ((current === undefined) || (current === null) || !current.hasOwnProperty(segment)) {
      return fallback;
    } else {
      current = current[segment];
    }
  }
  return current;
}

function openStarsectorModPage(api: IExtensionApi) {
  return (gameId: string, modId: string, source: string) => {
    if (gameId !== GAME_ID) return; // exit for other games

    const state = api.getState();
    const mods: IMod[] = util.getSafe(state, ['persistent', 'mods', 'starsector'], undefined);
    if (!mods) return; // no mods?!
    const mod = Object.values(mods).find(mod => util.getSafe(mod.attributes, [ModAttributes.modVariantId], null) == modId)
    if (!mod) return; // could not resolve the mod ID for some reason. 
    const threadId = util.getSafe(mod.attributes, [ModAttributes.forumThreadId], null)
    if (!threadId) return

    util.opn(getModForumThreadPage(threadId)).catch(err => undefined);
  }
}

function getModForumThreadPage(modThreadId: string): string {
  return STARSECTOR_FORUM_URL + '?topic=' + modThreadId
}

/**
 * A subset of the available mod metadata.
 */
export class ModAttributes {
  static readonly modSharedId = 'modSharedId'
  static readonly modVariantId = 'modId'
  static readonly modName = 'modName'
  static readonly author = 'author'
  static readonly fileName = 'fileName'
  static readonly source = 'source'
  static readonly forumThreadId = 'forumThreadId'
  static readonly displayVersion = 'version'
  static readonly localVersionCheckerVersion = 'localVersionCheckerVersion'
  static readonly onlineVersionUrl = 'onlineVersionUrl'
  static readonly onlineVersionCheckerVersion = 'onlineVersionCheckerVersion'
  static readonly gameVersion = 'gameVersion'
  static readonly lastUpdateTime = 'lastUpdateTime'
}

export class Version {
  major: string
  minor: string
  patch: string
}

export class VersionFile {
  masterVersionFile: string
  modName: string
  modThreadId: string
  modVersion: Version
}

module.exports = {
  default: main
};
