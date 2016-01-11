"use strict";

require('dotenv').load();

let DigitalOceanAPI = require('digital-ocean-api'),
  util = require('util'),
  q = require('q'),
  async = require('async'),
  Ping = require('ping-lite'),
  moment = require('moment'),
  _ = require('underscore'),
  mongoClient = require('mongodb').MongoClient,
  api = new DigitalOceanAPI({
    token: process.env.DIGITAL_OCEAN_API_TOKEN
  }),
  storedState;

const MONGO_COLLECTION = 'data',
  MONGO_DOCUMENT_ID = 'verifier-data';


// Don't need to overthink this.  Our data model is a single 
// JSON document that will hold all the persistent state
q.ninvoke(mongoClient, 'connect', process.env.MONGOLAB_URI)
  .then((db) => {
    let coll = db.collection(MONGO_COLLECTION);

    return q.ninvoke(coll.find({ id: MONGO_DOCUMENT_ID}), 'next')
      .then((stateDocument) => {
        if (!stateDocument) {
          let initialState = { id: MONGO_DOCUMENT_ID, droplets: [] };
          return q.ninvoke(coll, 'insertOne', initialState)
            .then(() => {
              storedState = initialState;
            });
        } else {
          storedState = stateDocument;
        }
        
      })
      .then(() => {
        db.close();
      });
  })
  .then(() => {
    return q.ninvoke(api, 'listDroplets')
      .then((droplets) => {
        let dropletsBackingUp = droplets.filter((droplet) => { return droplet.features.some((feature) => feature === 'backups');});
        return dropletsBackingUp;
      })
      .then((backingUpDroplets) => {
        return q.ninvoke(async, 'forEachSeries', backingUpDroplets, 
                         (droplet, cb) => {
                           return verifyBackupsForDroplet(droplet).nodeify(cb);
                         });
      })
  })
  .then(() => {
    console.log('All done!');
    process.exit(0);
  })
  .catch((err) => {
    console.log(err.stack);
  });

function verifyBackupsForDroplet(droplet) {
  let storedDroplet = _.findWhere(storedState.droplets, {id: droplet.id}),
    storedDropletIndex = _.indexOf(storedState.droplets, storedDroplet);

  if (!storedDroplet) {
    storedDroplet = { backups: [] };
    storedState.droplets.push(storedDroplet);
    storedDropletIndex = storedState.droplets.length - 1;
  }
  
  // For each droplet gather up the unverified backups and verify them one by one
  return q.ninvoke(api, 'listDropletBackups', droplet.id)
    .then((backups) => {
      let backupsToVerify = backups.filter((backup) => !storedDroplet.backups.some((storedBackup) => backup.id === storedBackup.id && storedBackup.verified));
      
      return q.ninvoke(async, 'forEachSeries', backupsToVerify,
                       (backup, cb) => {
                         return verifyBackup(backup, droplet)
                           .then((result) => {
                             let storedBackup = _.findWhere(storedDroplet.backups, { id: backup.id }),
                               storedBackupIndex = _.indexOf(storedDroplet.backups, storedBackup);

                             if (!storedBackup) {
                               storedBackup = {
                                 id: backup.id,
                                 verificationStatus: result.backupStatus,
                                 reason: result.reason,
                                 timeChecked: result.timeChecked
                               };
                               storedDroplet.backups.push(storedBackup);
                             } else {
                               storedDroplet.backups[storedBackupIndex] = {
                                 id: backup.id,
                                 verificationStatus: result.backupStatus,
                                 reason: result.reason,
                                 timeChecked: result.timeChecked
                               };
                             }
                           })
                           .then(() => {
                             return persistState();
                           }).nodeify(cb);
                       });
    })
}

function persistState() {
  return q.ninvoke(mongoClient, 'connect', process.env.MONGOLAB_URI)
    .then((db) => {
      let coll = db.collection(MONGO_COLLECTION);

      console.log(`Saving state to Mongo: ${util.inspect(storedState)}`);

      return q.ninvoke(coll, 'findOneAndUpdate', {id: MONGO_DOCUMENT_ID}, { $set: storedState }, { returnOriginal: false })
        .then(() => {
          console.log('State should be saved.');
          db.close();
        });
    });
}

/***
 * From DO API object representing a backup and
 * DO API object representing the droplet the backup
 * is associated with, creates a new droplet from the backup
 * with the same config as the original droplet,
 * waits for it come out of the "new" state, then
 * pings it to confirm the droplet booted 
 * Considers change from "new" -> "active" state and
 * response to ping from the new droplet as evidence that
 * the backup is valid.  We at least know that we can boot
 * a fresh machine from it, which we were unable to do
 * from corrupted DO backups created on 12/17/15 &
 * 1/3/16.
 *
 * Returns {
 *   backupStatus: 'valid' | 'corrupt',
 *   timeChecked: ISO formatted UTC date of time this entry was made
 *   reason: 'Why it thinks backup is corrupt'
 * }
 *
 * may throw verification error
 */
function verifyBackup(backup, droplet) {
  let verificationDropletConfig = {
    name: `backup-${backup.id}-verifier`,
    region: droplet.region.slug,
    size: droplet.size.slug,
    image: backup.id,
    ssh_keys: null,
    backups: false
  };

  return q.ninvoke(api, 'createDroplet', verificationDropletConfig)
    .then((createResponse) => {
      return waitUntilNotNew(createResponse.id)
        .then((droplet) => {
          if (droplet.status === 'active') {
            if (!droplet.networks || !droplet.networks.v4 || !droplet.networks.v4.length || ! droplet.networks.v4[0].ip_address) {
              throw new Error(`Verification error.  Created droplet ${droplet.id} doesn't have IPv4 address`);
            }
            return respondsToPing(droplet.networks.v4[0].ip_address)
              .then((responds) => {
                if (responds) {
                  return {
                    backupStatus: 'valid',
                    timeChecked: moment.utc().format()
                  };
                } else {
                  return {
                    backupStatus: 'corrupt',
                    reason: `Created droplet ${droplet.id} is 'active', but doesn't respond to ping`,
                    timeChecked: moment.utc().format()
                  };
                }
              });

          } else {
            return {
              backupStatus: 'corrupt',
              reason: `Created droplet ${droplet.id} changed status to '${droplet.status}' instead of 'active'`,
              timeChecked: moment.utc().format()
            };
          }
        });
    });
}

function respondsToPing(ip) {
  function respondsToPingInner(ip, retriesRemaining) {
    let ping = new Ping(ip);

    return q.ninvoke(ping, 'send')
      .then(function(ms) {
        if (ms === null) {
          if (retriesRemaining) {
            return respondsToPingInner(ip, retriesRemaining - 1);
          } else {
            return false;
          }
        } else {
          return true;
        }
      });
  }

  const PING_RETRY_COUNT = 5;
  return respondsToPing(ip, PING_RETRY_COUNT);
  
};

function waitUntilNotNew(dropletId) {
  return q.ninvoke(api, 'getDroplet', dropletId)
    .then((droplet) => {
      if (droplet.status === 'new') {
        console.log(`droplet (${dropletId}) status is still 'new'.  Waiting a minute...`);
        // Wait for a minute before checking again
        return q.delay(60000)
          .then(() => { return waitUntilActive(dropletId); });
      } else {
        console.log(`droplet (${dropletId}) status is now ${droplet.status}.`);
        return droplet;
      }
    });
}
 setInterval(() => { console.log('heartbeat!');}, 30000);
