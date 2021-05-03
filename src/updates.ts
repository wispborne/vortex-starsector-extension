import { IExtensionApi, IMod } from "vortex-api/lib/types/api";
import { actions, util, log } from "vortex-api";
import * as semver from "semver";
import { GAME_ID, Version, parseJson, VersionFile, ModAttributes } from '.'
import axios, { AxiosResponse } from 'axios';
import hjson = require('hjson');

const UPDATE_CHECK_DELAY = 60 * 60 * 1000;

export async function checkForStarsectorModsUpdates(api: IExtensionApi, gameId: string, mods: { [id: string]: IMod }) {
    if (gameId !== GAME_ID) {
        return Promise.resolve();
    }
    let notificationId = 'starsector-check-update-progress'
    var now = Date.now()
    var store = api.store;
    var filteredMods = Object.values(mods)
    // .filter(mod =>(now - (util.getSafe(mod.attributes, ['lastUpdateTime'], 0) || 0)) > UPDATE_CHECK_DELAY);
    log('debug', 'running update check', { count: filteredMods.length });
    // const filteredIds = new Set(mods.map(mod => mod.id));
    if (filteredMods.length == 0) {
        return Promise.resolve();
    }
    let pos = 0;
    const progress = () => {
        store.dispatch(actions.addNotification({
            id: notificationId,
            type: 'activity',
            message: 'Checking Starsector mods for update',
            progress: (pos * 100) / filteredMods.length,
        }));
        ++pos;
    };
    progress();
    var modList: IMod[] = await Promise.all(filteredMods.map(async (mod: IMod) => {
        var modId = mod.id;
        var modWithOnlineVersion = await getOnlineModVersion(mod);
        log('info', `pulled data for ${modId}`, { onlineVersion: modWithOnlineVersion });
        if (modWithOnlineVersion == null) {
            log('warn', `Failed to check for update for ${modId}`, { onlineVersion: modWithOnlineVersion });
            return null
        }
        let version = "";
        try {
            version = (typeof (modWithOnlineVersion.modVersion) === 'string')
                ? modWithOnlineVersion.modVersion
                : concatVersionObject(modWithOnlineVersion.modVersion)
        } catch (e) { }

        store.dispatch(actions.setModAttribute(gameId, modId, ModAttributes.onlineVersion, version));
        mod.attributes[ModAttributes.onlineVersion] = version
        return mod
    }));
    var updates = modList.filter(mod => {
        return mod != null && isRemoteVersionNewer(mod.attributes[ModAttributes.version], mod.attributes[ModAttributes.onlineVersion])
    })
    for await (const mod of updates) {
        log('info', 'found update for mod', { mod: mod.id, installed: mod.attributes[ModAttributes.version], update: mod.attributes[ModAttributes.onlineVersion] })
        store.dispatch(actions.setModAttribute(gameId, mod.id, ModAttributes.lastUpdateTime, now));
        progress();
    };
    store.dispatch(actions.dismissNotification(notificationId));

    if (updates.length > 0) {
        store.dispatch(actions.addNotification({
            id: notificationId,
            type: 'success',
            message: `${updates.length} update(s) found for Starsector mods.${updates.map(mod => {
                let name = util.getSafe(mod.attributes, [ModAttributes.modName], '')
                let oldVer = util.getSafe(mod.attributes, [ModAttributes.version], '')
                let newVer = util.getSafe(mod.attributes, [ModAttributes.onlineVersion], '')
                return `\n${name} (${newVer} vs ${oldVer})`;
            })}`
        }));

        updates
            .filter(mod => util.getSafe(mod.attributes, ['source'], null))
            .forEach(modWithUpdate => {
                // Set the attribute to unknown so that Vortex shows the "open in browser" icon
                // https://github.com/Nexus-Mods/Vortex/blob/76b77494db78e39568cb12fe31e83c04ce1a2903/src/extensions/mod_management/util/modUpdateState.ts#L33
                store.dispatch(actions.setModAttribute(gameId, modWithUpdate.id, "newestFileId", "unknown"));
            });
    }
}

export async function getOnlineModVersion(mod: IMod): Promise<VersionFile> | null {
    log('debug', 'retrieving latest version of ' + mod.id, { mod });
    var updatedMod = await getApiResponse<VersionFile>(util.getSafe(mod.attributes, [ModAttributes.onlineVersionUrl], ''), (data: VersionFile) => {
        return typeof (data) === 'string'
            ? parseJson(data)
            : data;
    });
    return updatedMod;
}

/**
 * Helper method for retrieving data.
 *
 * @remarks
 * - This method is just the common logic and needs a callback to declare what to return from the output.
 *
 * @param url - The endpoint URL for the request.
 * @param returnHandler - A callback to take the API response and return specific data.
 * @returns The API response. Returns null on error/not found
 */
async function getApiResponse<T>(url: string, returnHandler: (data: any) => T): Promise<T> | null {
    var resp = await axios.request({
        url: url,
        headers: {}
    }).then((resp: AxiosResponse) => {
        const { data } = resp;
        return returnHandler(data);
    }).catch(err => {
        log('error', err);
        return null;
    });
    return resp;
}

export function concatVersionObject(version: { major: string, minor: string, patch: string }): string {
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

    return versionElements.join('.');
}

/**
 * https://github.com/LazyWizard/version-checker/blob/master/src/org/lazywizard/versionchecker/VersionChecker.java#L234
 */
function isRemoteVersionNewer(localVersion: string, remoteVersion: string) {
    if (!localVersion || !remoteVersion) {
        return false;
    }

    // Remove all non-version data from the version information,
    // then split the version number and release candidate number
    // (ex: "Starsector 0.65.2a-RC1" becomes {"0.65.2","1"})
    let localRaw = localVersion.replace("[^0-9.-]", "").split("-", 2);
    let remoteRaw = remoteVersion.replace("[^0-9.-]", "").split("-", 2);

    // Assign array values to variables (solely for clarity's sake)
    let vLocal = localRaw[0], vRemote = remoteRaw[0],
        rcLocalRaw = (localRaw.length > 1 ? localRaw[1].replace("\\D", "") : "0"),
        rcRemoteRaw = (remoteRaw.length > 1 ? remoteRaw[1].replace("\\D", "") : "0")

    let rcLocal = (rcLocalRaw.length == 0 ? 0 : parseInt(rcLocalRaw)),
        rcRemote = (rcRemoteRaw.length == 0 ? 0 : parseInt(rcRemoteRaw));

    // Check major.minor versions to see if remote version is newer
    // Based on StackOverflow answer by Alex Gitelman found here:
    // http://stackoverflow.com/a/6702029/1711452
    if (vLocal != vRemote) {
        // Split version number into major, minor, patch, etc
        let localMajorMinor = vLocal.split("\\."),
            remoteMajorMinor = vRemote.split("\\.");
        let i = 0;
        // Iterate through all subversions until we find one that's not equal
        while (i < localMajorMinor.length && i < remoteMajorMinor.length
            && localMajorMinor[i] == remoteMajorMinor[i]) {
            i++;
        }
        // Compare first non-equal subversion number
        if (i < localMajorMinor.length && i < remoteMajorMinor.length) {
            // Pad numbers so ex: 0.65 is considered higher than 0.6
            let localPadded: string = localMajorMinor[i].padEnd(3, '0'),
                remotePadded: string = remoteMajorMinor[i].padEnd(3, '0');
            return remotePadded > localPadded;
        }
        // If version length differs but up to that length they are equal,
        // then the longer one is a patch of the shorter
        else {
            return remoteMajorMinor.length > localMajorMinor.length;
        }
    }

    // Check release candidate if major.minor versions are the same
    return rcRemote > rcLocal;
}