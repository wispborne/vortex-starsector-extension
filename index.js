// @ts-check
const Promise = require('bluebird');
const path = require('path');
const rjson = require('relaxed-json');
const { fs, log, util, selectors } = require('vortex-api');
const winapi = require('winapi-bindings');
const semver = require('semver');

const GAME_ID = 'starsector';
const MOD_INFO_FILE = "mod_info.json"
const VERSION_CHECKER_FILE_EXT = ".version"

// Adapted from https://stackoverflow.com/a/24518413/1622788
// Removes '#'s, which are used as comments by the game's json parser
const COMMENT_STRIPPING_REGEX = /((["'])(?:\\[\s\S]|.)*?\2|\#(?![*\#])(?:\\.|\[(?:\\.|.)\]|.)*?\#)|\#.*?$|\#\*[\s\S]*?\*\#/gm;

/**
 * @returns {string | Promise<String>}
 */
function findGame() {
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

function testSupportedContent(files, gameId) {
  if (gameId !== GAME_ID) {
    return Promise.resolve({ supported: false });
  }

  const contentPath = files.find(file => path.basename(file) === MOD_INFO_FILE);
  return Promise.resolve({
    supported: contentPath !== undefined,
    requiredFiles: [contentPath],
  });
}

async function installContent(
  contextApi,
  files,
  destinationPath,
  gameId,
  progressDelegate) {
  const modInfoFile = files.find(file => path.basename(file) === MOD_INFO_FILE);
  const basePath = path.dirname(modInfoFile);

  let outputPath = basePath;

  const contentFile = path.join(destinationPath, modInfoFile);
  return fs.readFileAsync(contentFile, { encoding: 'utf8' })
    .then(data => {
      const attrInstructions = [];
      let parsed;
      try {
        // Strip '#' comments using regex, then parse using relaxed-json
        parsed = rjson.parse(data.replace(COMMENT_STRIPPING_REGEX, "$1"));
      } catch (err) {
        log('warn', MOD_INFO_FILE + ' invalid: ' + err.message);
        return Promise.resolve(attrInstructions);
      }

      // Function to get a value from mod_info.json by key
      const getAttr = key => {
        try {
          return parsed[key];
        } catch (err) {
          log('info', 'attribute missing in ' + MOD_INFO_FILE, { key });
          return "";
        }
      }

      // If mod_info.json has no id, this is an invalid mod
      const contentModId = getAttr('id');
      if (contentModId === undefined) {
        return Promise.reject(
          new util.DataInvalid('Missing, invalid or unsupported ' + MOD_INFO_FILE));
      }

      outputPath = (modInfoFile.indexOf(MOD_INFO_FILE) > 0)
        ? path.basename(path.dirname(modInfoFile))
        : Promise.reject(
          new util.DataInvalid('Missing, invalid or unsupported ' + MOD_INFO_FILE));

      // Don't overwrite name because authors tend to put "beta 1" or "RC1" or "WIP 3"
      // in the Nexus or archive name, but not in the metadata name or metadata version.
      // We don't want to lose that information, even to have a nicer-looking name than the archive filename.
      // attrInstructions.push({
      //   type: 'attribute',
      //   key: 'customFileName',
      //   value: getAttr('name').trim(),
      // });

      // Set the mod version based on mod_info.json
      var version = getAttr('version')
      try {
        // Works if using old schema where version is just a string
        version = version.trim()
      } catch {
        // Else use new schema where version is an object with major, minor, patch.
        try {
          var versionElements = [];
          
          if (version["major"] != null) {
            versionElements.push(version["major"].toString());
          }

          if (version["minor"] != null) {
            versionElements.push(version["minor"].toString());
          }

          if (version["patch"] != null) {
            versionElements.push(version["patch"].toString());
          }

          version = versionElements.join('.');
        } catch {
        }
      }

      if (typeof (version) === 'string') {
        attrInstructions.push({
          type: 'attribute',
          key: 'version',
          value: version,
        });
      }

      // Description is fairly hidden in the UI, and we don't want to overwrite it
      // if it's being set from Nexus Mods.
      // attrInstructions.push({
      //   type: 'attribute',
      //   key: 'description',
      //   value: getAttr('description').trim(),
      // });

      // Set the mod author based on mod_info.json
      attrInstructions.push({
        type: 'attribute',
        key: 'author',
        value: getAttr('author'),
      });

      return Promise.resolve(attrInstructions);
    })
    .then(attrInstructions => {

      // Read the version file, if it exists
      const versionCheckerFile = files.find(file => path.extname(file) === VERSION_CHECKER_FILE_EXT);
      log('info', 'Found version checker file: ' + versionCheckerFile)

      if (versionCheckerFile) {
        const contentFile = path.join(destinationPath, versionCheckerFile);

        return fs.readFileAsync(contentFile, { encoding: 'utf8' })
          .then(versionCheckerData => {
            let parsedVerCheckData;
            try {
              // Strip '#' comments using regex, then parse using relaxed-json
              parsedVerCheckData = rjson.parse(versionCheckerData.replace(COMMENT_STRIPPING_REGEX, "$1"));
            } catch (err) {
              const errMsg = versionCheckerFile + ' invalid: ' + err.message
              log('warn', errMsg);

              contextApi.showErrorNotification(errMsg, {});
              return Promise.resolve(attrInstructions);
            }

            // Function to get a value from mod_info.json by key
            const getAttr = key => {
              try {
                return parsedVerCheckData[key];
              } catch (err) {
                log('info', 'attribute missing in ' + versionCheckerFile, { key });
                return "";
              }
            }

            // Set the forum thread id based on the Version Checker file
            attrInstructions.push({
              type: 'attribute',
              key: 'forumThreadId',
              value: getAttr('modThreadId'),
            });

            return Promise.resolve(attrInstructions);
          })
      } else {
        return Promise.resolve(attrInstructions);
      }
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
function migrateFrom_1_1_0(api, oldVersion) {
  if (semver.gt(oldVersion, '1.1.0')) {
    return Promise.resolve();
  }

  const state = api.store.getState();
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  const modKeys = Object.keys(mods);

  if (modKeys.length === 0) {
    return Promise.resolve();
  }
}

/**
 * @param {import('vortex-api/lib/types/api').IExtensionContext} context
 */
function main(context) {
  context.registerGame({
    id: GAME_ID,
    name: 'Starsector',
    mergeMods: true,
    queryPath: findGame,
    queryModPath: () => 'mods',
    logo: 'gameart.jpg',
    executable: () => 'starsector.exe',
    requiredFiles: [
      'starsector.exe',
    ]
  });

  context.registerMigration(old => migrateFrom_1_1_0(context.api, old));

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
        util.opn('https://fractalsoftworks.com/forum/index.php?topic=' + forumThreadId)
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

  return true;
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

module.exports = {
  default: main
};
