// @ts-check

//const JAZ_ATLAS = 'https://s3.jazco.io/exported_graph_enriched.json';
const JAZ_ATLAS_MIN = 'https://s3.jazco.io/exported_graph_minified.json';

const fs = require('fs');
const path = require('path');


/** @typedef {[handle: string, x: number, y: number, weight: number, displayName?: string]} UserTuple */

/** @param {string | null | undefined} did */
function shortenDID(did) {
  return typeof did === 'string' ? did.replace(/^did\:plc\:/, '') : did;
}

/** @param {string} handle */
function shortenHandle(handle) {
  return handle.replace(_shortenHandle_Regex, '');
}
const _shortenHandle_Regex = /\.bsky\.social$/;

/**
 * https://stackoverflow.com/a/29018745/140739
 * @param {T[]} arr
 * @param {T} el
 * @param {(el1: T, el2: T) => number | null | undefined} compare_fn 
 * @returns {number}
 * @template T
 */
function binarySearch(arr, el, compare_fn) {
  let m = 0;
  let n = arr.length - 1;
  while (m <= n) {
    let k = (n + m) >> 1;
    let cmp = /** @type {number} */(compare_fn(el, arr[k]));
    if (cmp > 0) {
      m = k + 1;
    } else if (cmp < 0) {
      n = k - 1;
    } else {
      return k;
    }
  }
  return ~m;
}

async function run() {
  console.log('Getting current hot users...');
  const oldHotUsersRaw = fs.existsSync(path.join(__dirname, './hot-old.js')) ?
    fs.readFileSync(path.join(__dirname, './hot-old.js'), 'utf8').trim() :
    fs.readFileSync(path.join(__dirname, './hot.js'), 'utf8').trim();
  const jsonpLead = oldHotUsersRaw.slice(0, 1000).split('\n')[0];
  const jsonpTrail = oldHotUsersRaw.slice(-1000).split('\n').pop();
  const oldHotUsers = JSON.parse(
    '{' +
    oldHotUsersRaw.slice(jsonpLead.length, -jsonpTrail.length) +
    '}');
  console.log(Object.keys(oldHotUsers).length, ' existing hot users loaded.')

  console.log('Getting archived users...');
  const archiveJsonFiles = fs.readdirSync(__dirname).filter(s => /^store/.test(s));
  const archived = {};
  for (const arch of archiveJsonFiles) {
    console.log('  ' + arch);
    const archRaw = fs.readFileSync(path.join(__dirname, arch), 'utf8').trim();
    const loadFn = eval('(function (' + path.basename(arch, '.js').replace(/\-/g, '') + ') { ' + archRaw + ' })');
    /** @type {*} */
    let value;
    loadFn(v => value = v);

    for (const shortDID in value) {
      archived[shortDID] = value[shortDID];
    }
  }

  console.log('Loaded ' + Object.keys(archived).length + ' archived users.');

  const shortDIDByShortHandle = {};
  for (const shortDID in archived) {
    const shortHandle = shortenHandle(archived[shortDID][0]);
    shortDIDByShortHandle[shortHandle] = shortDID;
  }
  for (const shortDID in oldHotUsers) {
    const shortHandle = shortenHandle(oldHotUsers[shortDID][0]);
    shortDIDByShortHandle[shortHandle] = shortDID;
  }

  const useCached = fs.existsSync(path.resolve(__dirname, './atlas-raw.json'));
  console.log(useCached ? 'Loading cached raw atlas...' : 'Downloading...');
  const atlasRaw = useCached ?
    fs.readFileSync(path.resolve(__dirname, './atlas-raw.json')) :
    await downloadAtlasBinary();

  if (!useCached) {
    console.log('Preserving downloaded binary...');
    fs.writeFileSync(path.resolve(__dirname, './atlas-raw.json'), atlasRaw);
  }

  console.log('Parsing...');
  const atlasJson = JSON.parse(atlasRaw.toString('utf8'));

  /** @type {{ [shortDID: string]: UserTuple }} */
  const hot = {};

  /** @type {{ shortDID: string, past: UserTuple, current: UserTuple }[]} */
  let pairs = [];

  let unknownHandles = [];

  for (const n of atlasJson.nodes) {
    const node = n.attributes;
    const shortHandle = shortenHandle(node.label);
    let shortDID = shortenDID(node.did);
    if (!shortDID) shortDID = shortDIDByShortHandle[shortHandle];
    if (!shortDID) {
      unknownHandles.push(shortHandle);
      continue;
    }

    const x = node.x;
    const y = node.y;
    const size = node.size;

    const oldUsrTuple = oldHotUsers[shortDID];
    const oldDisplayName = !oldUsrTuple ? undefined :
      typeof oldUsrTuple[4] === 'string' ? oldUsrTuple[4] :
        typeof oldUsrTuple[3] === 'string' ? oldUsrTuple[3] :
          undefined;

    /** @type {UserTuple} */
    const newUsrTuple =
      oldDisplayName ? [shortHandle, x, y, size, oldDisplayName] :
        [shortHandle, x, y, size];
    
    hot[shortDID] = newUsrTuple;

    if (oldUsrTuple) pairs.push({ shortDID, past: oldUsrTuple, current: newUsrTuple });
  }

  console.log('Prepared ' + Object.keys(hot).length + ' hot users.');
  console.log('completely unknown handles: ' + unknownHandles.length);


  console.log('Accounting for disapperances...');
  /** @type {typeof hot} */
  const exes = {};
  for (const shortDID in oldHotUsers) {
    if (!hot[shortDID]) {
      exes[shortDID] = oldHotUsers[shortDID];
    }
  }
  console.log(Object.keys(exes).length + ' users disappeared.');

  console.log('Pareparing proximities...');
  /** @type {typeof pairs} */
  const pairsByOldX = pairs.slice().sort((p1, p2) => p1.past[1] - p2.past[1]);
  /** @type {typeof pairs} */
  const pairsByOldY = pairs.slice().sort((p1, p2) => p1.past[2] - p2.past[2]);

  const applied = { ...hot };
  console.log('Applying turn and expand to missing users...');
  let appliedCount = 0;
  for (const shortDID in exes) {
    const oldTuple = exes[shortDID];
    let [shortHandle, x, y, weight, displayName] = oldTuple;
    if (typeof weight === 'string') {
      displayName = weight;
      weight = /** @type {*} */(undefined);
    }

    const proximityXIndex = Math.abs(binarySearch(
      pairsByOldX,
      { shortDID, past: oldTuple, current: oldTuple },
      (pair1, pair2) => pair1.past[1] - pair2.past[1]));

    const proximityYIndex = Math.abs(binarySearch(
      pairsByOldY,
      { shortDID, past: oldTuple, current: oldTuple },
      (pair1, pair2) => pair1.past[1] - pair2.past[1]));

    const considerNeighbourDomain = 100;
    const neighbourCandidates = [...new Set(
      pairsByOldX.slice(
        Math.max(0, proximityXIndex - considerNeighbourDomain),
        Math.min(pairsByOldX.length, proximityXIndex + considerNeighbourDomain + 1))
        .concat(
          pairsByOldY.slice(
            Math.max(0, proximityYIndex - considerNeighbourDomain),
            Math.min(pairsByOldY.length, proximityYIndex + considerNeighbourDomain + 1))
      ))];
    neighbourCandidates.sort((p1, p2) => {
      const dist1 = Math.sqrt((p1.past[1] - x) ** 2 + (p1.past[2] - y) ** 2);
      const dist2 = Math.sqrt((p2.past[1] - x) ** 2 + (p2.past[2] - y) ** 2);
      return dist1 - dist2;
    });

    const useClosestNeigbours = 4;
    let oldCentreX = 0, oldCentreY = 0;
   let newCentreX = 0, newCentreY = 0;
    for (let i = 0; i < useClosestNeigbours; i++) {
      oldCentreX += neighbourCandidates[i].past[1];
      oldCentreY += neighbourCandidates[i].past[2];
      newCentreX += neighbourCandidates[i].current[1];
      newCentreY += neighbourCandidates[i].current[2];
    }
    oldCentreX /= useClosestNeigbours;
    oldCentreY /= useClosestNeigbours;
    newCentreX /= useClosestNeigbours;
    newCentreY /= useClosestNeigbours;

    const newX = newCentreX + (x - oldCentreX);
    const newY = newCentreY + (y - oldCentreY);

    applied[shortDID] = displayName ?
      [shortHandle, newX, newY, weight, displayName] :
      [shortHandle, newX, newY, weight];
    
    appliedCount++;
  }

  console.log('Applied ' + appliedCount + ', total ' + Object.keys(applied).length + ' users.');

  console.log('Saving conservative new...');
  fs.writeFileSync(
    path.resolve(__dirname, './hot-new.js'),
    jsonpLead +
    Object.keys(hot)
      .map(key => JSON.stringify(key) + ':' + JSON.stringify(hot[key]))
      .join(',\n') +
    '\n' + jsonpTrail);

  console.log('Saving conservative+applied new...');
  fs.writeFileSync(
    path.resolve(__dirname, './hot-applied.js'),
    jsonpLead +
    Object.keys(applied)
      .map(key => JSON.stringify(key) + ':' + JSON.stringify(applied[key]))
      .join(',\n') +
    '\n' + jsonpTrail);

  fs.writeFileSync(
    path.resolve(__dirname, './exes.js'),
    jsonpLead.replace(/hot/g, 'exes') +
    Object.keys(exes)
      .map(key => JSON.stringify(key) + ':' + JSON.stringify(exes[key]))
      .join(',\n') +
    '\n' + jsonpTrail);
}

async function downloadAtlasBinary() {

  try {
    const downl = await downloadFrom(JAZ_ATLAS_MIN);
    if (downl.length) return downl;
  } catch (error) {
  }

  return downloadFrom(
    'https://corsproxy.io/?' +
    JAZ_ATLAS_MIN
  );

  function downloadFrom(url) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      https.get(url, (resp) => {
        const buffers = [];
        resp.on('data', (chunk) => {
          buffers.push(chunk);
        });
        resp.on('error', (err) => {
          reject(err);
        });
        resp.on('end', () => {
          resolve(Buffer.concat(buffers));
        });
      });
    });
  }
}

run();
