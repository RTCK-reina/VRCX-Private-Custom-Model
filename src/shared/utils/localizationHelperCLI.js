// Because this isn't a package (just a loose js file), we have to use require
// statements

const process = require('node:process');
const fs = require('node:fs');
const path = require('node:path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const getLocalizationObjects = function* () {
    const localeFolder = './src/localization';
    const files = fs
        .readdirSync(localeFolder, { withFileTypes: true })
        .filter(
            (file) =>
                file.isFile() &&
                path.extname(file.name).toLowerCase() === '.json'
        );
    for (const file of files) {
        const filePath = path.join(localeFolder, file.name);
        const jsonStr = fs.readFileSync(filePath);
        yield [filePath, JSON.parse(jsonStr)];
    }
};

const addKey = function (obj, objects, value, above_key) {
    console.log(
        `Adding key to ${obj.language} at path '${objects.join('.')}' with value '${value}' above key '${above_key}'`
    );

    let currentObj = obj;
    let i = 0;

    // Last element is final key not object so loop n - 1 times
    for (; i < objects.length - 1; i++) {
        if (!Object.hasOwn(currentObj, objects[i])) {
            currentObj[objects[i]] = {};
        }

        currentObj = currentObj[objects[i]];
    }
    InsertKeyInObj(currentObj, objects[i], value, above_key);
};

// Shamelessly stolen from https://stackoverflow.com/a/55017155/11030436
const InsertKeyInObj = (obj, key, value, above_key) => {
    const keys = Object.keys(obj);
    if (keys.length === 0 || !Object.hasOwn(obj, above_key)) {
        obj[key] = value;
        return obj;
    }

    // Reconstruct object from scratch, inserting our new key when the next
    // key is the above_key

    // Again utilize the dummy key in case we're adding above the first key
    keys.unshift('dummy');
    obj.dummy = {};
    const ret = keys.reduce((newObj, currKey, i) => {
        if (currKey !== key) {
            newObj[currKey] = obj[currKey];
        }

        if (i < keys.length - 1 && keys[i + 1] === above_key) {
            newObj[key] = value;
        }

        return newObj;
    }, {});
    delete ret.dummy;

    // Clear keys on old object
    for (const key of keys) {
        delete obj[key];
    }

    // Assign new properties to old object
    Object.assign(obj, ret);
};

const addLocalizationKey = (key, value, above_key) => {
    const objects = key.split('.');

    for (const [localePath, localeObj] of getLocalizationObjects()) {
        addKey(localeObj, objects, value, above_key);
        fs.writeFileSync(localePath, `${JSON.stringify(localeObj, null, 4)}\n`);
    }

    console.log(`\`${key}:${value}\` added to every localization file!`);
};

const removeKey = (obj, objects, i = 0) => {
    console.log(
        `Removing key from ${obj.language} at path '${objects.join('.')}'`
    );
    if (!Object.hasOwn(obj, objects[i])) {
        return;
    }

    if (objects.length - 1 === i) {
        delete obj[objects[i]];
    } else {
        removeKey(obj[objects[i]], objects, i + 1);
        if (Object.keys(obj[objects[i]]).length === 0) {
            delete obj[objects[i]];
        }
    }
};

const removeLocalizationKey = (key) => {
    const objects = key.split('.');
    for (const [localePath, localeObj] of getLocalizationObjects()) {
        removeKey(localeObj, objects, 0);

        // All the localization files seem to have a trailing new line, so add
        // one ourselves
        fs.writeFileSync(localePath, `${JSON.stringify(localeObj, null, 4)}\n`);
    }

    console.log(`\`${key}\` removed from every localization file!`);
};

// Yes this code is extremely slow, but it doesn't run very often so.
const Validate = function () {
    const files = [...getLocalizationObjects()];
    const enIndex = files.findIndex(
        (file) => path.basename(file[0]) === 'en.json'
    );
    const [_, enObj] = files.splice(enIndex, 1)[0];

    const traverse = function (obj, predicate, pathes = []) {
        for (const key in obj) {
            if (typeof obj[key] === 'string' || obj[key] instanceof String) {
                predicate(obj, key, pathes);
            } else {
                traverse(obj[key], predicate, [...pathes, key]);
            }
        }
    };

    let hasRemoved = false;
    for (const [_, localeObj] of files) {
        let toRemove = [];
        traverse(localeObj, (_, key, pathes) => {
            let currObj = enObj;
            for (const pathSegment of pathes) {
                if (Object.hasOwn(currObj, pathSegment)) {
                    currObj = currObj[pathSegment];
                } else {
                    toRemove.push([...pathes, key]);
                    return;
                }
            }
            if (!Object.hasOwn(currObj, key)) {
                toRemove.push([...pathes, key]);
            }
        });

        // Remove after traversal finishes to not modify while iterating
        for (const toRemovePath of toRemove) {
            removeKey(localeObj, toRemovePath);
            hasRemoved = true;
        }
    }

    let toAdd = [];
    traverse(enObj, (obj, key, pathes) => {
        // Add above_key to the toAdd entry
        if (
            toAdd.length > 0 &&
            typeof toAdd.at(-1)[3] === 'undefined' &&
            toAdd.at(-1)[1].at(-2) === pathes.at(-1)
        ) {
            toAdd.at(-1)[3] = key;
        }

        for (const [_, localeObj] of files) {
            let currObj = localeObj;
            for (const pathSegment of pathes) {
                if (Object.hasOwn(currObj, pathSegment)) {
                    currObj = currObj[pathSegment];
                } else {
                    toAdd.push([
                        localeObj,
                        [...pathes, key],
                        obj[key],
                        undefined
                    ]);
                    return;
                }
            }

            if (!Object.hasOwn(currObj, key)) {
                toAdd.push([localeObj, [...pathes, key], obj[key], undefined]);
            }
        }
    });

    for (const addObj of toAdd) {
        addKey(...addObj);
    }

    if (toAdd.length > 0 || hasRemoved) {
        for (const [localePath, localeObj] of files) {
            fs.writeFileSync(
                localePath,
                `${JSON.stringify(localeObj, null, 4)}\n`
            );
        }
    } else {
        console.log('validation passed!');
    }
};

// Read-only drift report. Unlike `Validate`, this never writes files; it
// simply walks every locale against en.json and emits a per-locale diff
// of missing/extra keys. Returns true if ANY drift was detected, which
// we use to decide the process exit code when wired into CI.
const CheckDrift = function () {
    const files = [...getLocalizationObjects()];
    const enIndex = files.findIndex(
        (file) => path.basename(file[0]) === 'en.json'
    );
    if (enIndex === -1) {
        console.error('drift-check: en.json not found under src/localization');
        return true;
    }
    const [, enObj] = files[enIndex];
    const otherFiles = files.filter((_, idx) => idx !== enIndex);

    const traverse = function (obj, predicate, pathes = []) {
        for (const key in obj) {
            if (typeof obj[key] === 'string' || obj[key] instanceof String) {
                predicate(obj, key, pathes);
            } else {
                traverse(obj[key], predicate, [...pathes, key]);
            }
        }
    };

    const collectKeys = (root) => {
        const keys = new Set();
        traverse(root, (_, key, pathes) => {
            keys.add([...pathes, key].join('.'));
        });
        return keys;
    };

    const enKeys = collectKeys(enObj);
    let anyDrift = false;
    const summary = [];

    for (const [localePath, localeObj] of otherFiles) {
        const localeKeys = collectKeys(localeObj);

        const missing = [];
        for (const key of enKeys) {
            if (!localeKeys.has(key)) missing.push(key);
        }
        const extra = [];
        for (const key of localeKeys) {
            if (!enKeys.has(key)) extra.push(key);
        }

        if (missing.length || extra.length) {
            anyDrift = true;
        }
        summary.push({
            locale: path.basename(localePath),
            enTotal: enKeys.size,
            localeTotal: localeKeys.size,
            missing: missing.length,
            extra: extra.length,
            missingKeys: missing,
            extraKeys: extra
        });
    }

    summary.sort((a, b) => a.locale.localeCompare(b.locale));
    console.log('Localization drift report (vs en.json):');
    console.log(`  en.json: ${enKeys.size} keys`);
    for (const entry of summary) {
        const label = `  ${entry.locale.padEnd(12)}`;
        console.log(
            `${label} total=${entry.localeTotal} missing=${entry.missing} extra=${entry.extra}`
        );
        if (process.env.DRIFT_VERBOSE === '1') {
            if (entry.missingKeys.length) {
                console.log(`    missing keys (first 20):`);
                for (const key of entry.missingKeys.slice(0, 20)) {
                    console.log(`      - ${key}`);
                }
            }
            if (entry.extraKeys.length) {
                console.log(`    extra keys (first 20):`);
                for (const key of entry.extraKeys.slice(0, 20)) {
                    console.log(`      + ${key}`);
                }
            }
        }
    }
    if (!anyDrift) {
        console.log('no drift detected');
    } else {
        console.log(
            '\ndrift detected. Run `npm run localization validate` to sync keys, or set DRIFT_VERBOSE=1 to inspect individual keys.'
        );
    }
    return anyDrift;
};

const cliParser = yargs(hideBin(process.argv))
    .command({
        command: 'add <key> <value> [above_key]',
        aliases: ['a', 'replace', 'r'],
        desc: 'adds or replaces a key and value to all localization files above `above_key`',
        handler: (argv) =>
            addLocalizationKey(argv.key, argv.value, argv.above_key)
    })
    .command({
        command: 'remove <key>',
        aliases: ['rm', 'r'],
        desc: 'removes key from all localization files',
        handler: (argv) => removeLocalizationKey(argv.key)
    })
    .command({
        command: 'validate',
        aliases: [],
        desc: "removes keys from other languages that don't exist in the en translation and adds keys that don't exist in other languages",
        handler: Validate
    })
    .command({
        command: 'check-drift',
        aliases: ['drift'],
        desc: 'Read-only drift report vs en.json. Exits non-zero on drift. Set DRIFT_VERBOSE=1 to see individual keys.',
        handler: () => {
            const hasDrift = CheckDrift();
            process.exit(hasDrift ? 1 : 0);
        }
    })
    .demandCommand(1)
    .example([
        ['$0 add foo.bar "I\'m adding a key!"', 'Adding a key as `foo.bar`'],
        ['$0 remove foo.bar', 'removes the foo.bar key'],
        [
            '$0 add foo.bar "I\'m adding a key!" baz',
            'Adding a key aboe the existing `foo.baz` key'
        ]
    ])
    .help(false)
    .version(false);

cliParser
    .wrap(cliParser.terminalWidth())
    .command({
        command: 'help',
        aliases: ['h'],
        desc: 'Shows the help message',
        handler: () => cliParser.showHelp()
    })
    .fail(() => cliParser.showHelp())
    .parse();
