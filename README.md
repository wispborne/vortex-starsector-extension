# Vortex support for Starsector

Includes support for mod version and author(s) for mods installed from file, rather than from NexusMods.

This extension will read mod_info.json, stripping out comments that use the '#' sign, and extract the mod version and mod author(s) from the file, allowing Vortex to display this useful information, which is normally limited only to mods that are downloaded from NexusMods.

The displayed mod name will be the name of the mod's archive.
This is due to some mod authors releasing multiple iterations of a mod with the same version, with the only difference being in the filename.

For example, "ModName-3.0.0-beta-1.zip" and "ModName-3.0.0-beta-2.zip" often both have a version of 3.0.0. Since the beta number is important information, it should not be replaced by the name in the mod_info.json file, which may simply be "Mod Name".

## Contributing

To build and create a zip for distribution, run:

```bash
npm run build
./zip.sh
```

(don't forget to update the version in `package.json`, first!)
