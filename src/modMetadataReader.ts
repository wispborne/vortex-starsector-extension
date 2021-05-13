import { IExtensionContext, IDiscoveryResult, IGame, IState, ISupportedResult, ProgressDelegate, IInstallResult, IExtensionApi, IProfile, ThunkStore, IDeployedFile, IInstruction, ILink, IMod, IDialogResult } from 'vortex-api/lib/types/api';

// @ts-check
import Promise = require('bluebird');
import path = require('path');
import { fs, log, util, selectors, actions } from 'vortex-api';
import updates = require('./updates')
import { concatVersionObject } from './updates';
import { GAME_ID, parseJson, VersionFile, ModAttributes, STARSECTOR_FORUM_URL, MOD_INFO_FILE, VERSION_CHECKER_FILE_EXT } from '.'

export async function readModMetadata(contextApi: IExtensionApi, filesWithAbsolutePathsWithAbsolutePaths: string[]): Promise<Map<string, string>> {
    const modInfoFile = filesWithAbsolutePathsWithAbsolutePaths.find(file => path.basename(file) === MOD_INFO_FILE);
    let attributes = new Map<string, string>()

    if (!modInfoFile) {
        return Promise.reject(
            new util.DataInvalid(`${MOD_INFO_FILE} not found in a folder. The mod may be incorrectly packaged`));
    }
    // const modInfoFileAbsolute = path.join(destinationPath, modInfoFile);

    return fs.readFileAsync(modInfoFile, { encoding: 'utf8' })
        .then((data: string) => {
            let parsed;
            try {
                parsed = parseJson(data);
            } catch (err) {
                log('warn', MOD_INFO_FILE + ' invalid: ' + err.message);
                return Promise.resolve(attributes);
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
                    updates.concatVersionObject(version, false)
                } catch {
                }
            }

            if (typeof (version) === 'string') {
                // Tell Vortex to display the version from mod_info.json
                attributes[ModAttributes.displayVersion] = version
            }

            // Description is fairly hidden in the UI, and we don't want to overwrite it
            // if it's being set from Nexus Mods.
            // attrInstructions.push({
            //   type: 'attribute',
            //   key: 'description',
            //   value: getAttr('description').trim(),
            // });

            // Set the id of this mod's version based on mod_info.json
            attributes[ModAttributes.modVariantId] = getAttr('name')
            // Set the mod's shared id (eg 'lazylib) based on mod_info.json
            attributes[ModAttributes.modSharedId] = getAttr('id')
            // Set the name based on mod_info.json
            attributes[ModAttributes.modName] = getAttr('name')
            // Set the mod author based on mod_info.json
            attributes[ModAttributes.author] = getAttr('author')
            // Set the game version based on mod_info.json
            attributes[ModAttributes.gameVersion] = getAttr('gameVersion')


            // Read the version file, if it exists
            const versionCheckerFile = filesWithAbsolutePathsWithAbsolutePaths.find(file => path.extname(file) === VERSION_CHECKER_FILE_EXT);
            log('info', 'Found version checker file: ' + versionCheckerFile)

            if (versionCheckerFile) {
                // const contentFile = path.join(destinationPath, versionCheckerFile);

                return fs.readFileAsync(versionCheckerFile, { encoding: 'utf8' })
                    .then(versionCheckerData => {
                        let parsedVerCheckData;
                        try {
                            // Strip '#' comments using regex, then parse using relaxed-json
                            parsedVerCheckData = parseJson(versionCheckerData);
                        } catch (err) {
                            const errMsg = versionCheckerFile + ' invalid: ' + err.message
                            log('warn', errMsg);

                            contextApi.showErrorNotification(errMsg, {});
                            return Promise.resolve(attributes);
                        }

                        // Function to get a value from *.version by key
                        const getAttr = key => {
                            try {
                                return parsedVerCheckData[key];
                            } catch (err) {
                                log('info', 'attribute missing in ' + versionCheckerFile, { key });
                                return "";
                            }
                        }

                        let modThreadId = getAttr('modThreadId')

                        // Set the forum thread id based on the Version Checker file
                        attributes[ModAttributes.forumThreadId] = getAttr('modThreadId')

                        if (attributes[ModAttributes.forumThreadId]) {
                            // Set's the Vortex-specific "source" attribute, which is the forum
                            // Only if the mod is on the forum (has a modThreadId)
                            attributes[ModAttributes.source] = STARSECTOR_FORUM_URL
                        }

                        // Set the version based on the Version Checker file
                        attributes[ModAttributes.localVersionCheckerVersion] = concatVersionObject(getAttr('modVersion'), true)

                        // Set the online version file url based on the Version Checker file
                        attributes[ModAttributes.onlineVersionUrl] = getAttr('masterVersionFile')

                        return Promise.resolve(attributes);
                    })
            } else {
                return Promise.resolve(attributes);
            }
        })
}