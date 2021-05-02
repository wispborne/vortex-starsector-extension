import { IExtensionApi, IMod } from "vortex-api/lib/types/api";
import { actions, util, log } from "vortex-api";
import * as semver from "semver";
import { GAME_ID, IModDetails, Version, parseJson, VersionFile } from '.'
import axios, { AxiosResponse } from 'axios';
import hjson = require('hjson');

const UPDATE_CHECK_DELAY = 60 * 60 * 1000;

// TODO add the version checker url to IMod?
export async function checkForStarsectorModsUpdates(api: IExtensionApi, gameId: string, mods: { [id: string]: IMod }) {
    if (gameId !== GAME_ID) {
        return Promise.resolve();
    }
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
            id: 'starsector-check-update-progress',
            type: 'activity',
            message: 'Checking Starsector mods for update',
            progress: (pos * 100) / filteredMods.length,
        }));
        ++pos;
    };
    progress();
    var modList: IModDetails[] = await Promise.all(filteredMods.map(async (mod: IMod) => {
        var modId = util.getSafe(mod.attributes, ['modId'], '');
        var modWithOnlineVersion = await getOnlineModVersion(util.getSafe(mod.attributes, ['modId'], null));
        log('info', `pulled data for ${modId}`, { onlineVersion: modWithOnlineVersion });
        return modWithOnlineVersion
    }));
    var updates = modList.filter(su => {
        // if (!su.versions || su.versions.length == 0) {
        //     return false;
        // }
        su.versions.sort((a, b) => semver.rcompare(a.version, b.version));
        return semver.gt(su.versions[0].version, util.getSafe(su.mod.attributes, ['version'], '0.0.0'))
    })
        .map(su => {
            return { update: su.versions[0], mod: su.mod };
        });
    for await (const modSummary of updates) {
        log('info', 'found update for mod', { mod: modSummary.mod.id, update: modSummary.update.version })
        store.dispatch(actions.setModAttribute(gameId, modSummary.mod.id, 'newestVersion', modSummary.update.version));
        store.dispatch(actions.setModAttribute(gameId, modSummary.mod.id, 'newestFileId', modSummary.update._id));
        store.dispatch(actions.setModAttribute(gameId, modSummary.mod.id, 'lastUpdateTime', now));
        progress();
    };
    store.dispatch(actions.dismissNotification('bs-check-update-progress'));
}

export async function getOnlineModVersion(mod: IModDetails): Promise<IModDetails> | null {
    log('debug', 'retrieving latest version of ' + mod._id, { mod });
    var updatedMod = await getApiResponse<IModDetails>(mod.versionFileUrl, (data: string) => {
        var onlineVersionFile = parseJson<VersionFile>(data);
        mod.onlineVersion = onlineVersionFile.modVersion
        return mod
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

/**
 * https://github.com/LazyWizard/version-checker/blob/master/src/org/lazywizard/versionchecker/VersionChecker.java#L234
 */
function isRemoteVersionNewer(localVersion: string, remoteVersion: string) {
    if (localVersion == null || remoteVersion == null) {
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
            let localPadded = localMajorMinor[i].padEnd(3, '0'),
                remotePadded = remoteMajorMinor[i].padEnd(3, '0');
            return remotePadded.compareTo(localPadded) > 0;
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