"use strict";

require('dotenv').load();

let DigitalOceanAPI = require('digital-ocean-api'),
  util = require('util'),
  q = require('q'),
  async = require('async'),
  _ = require('underscore'),
  mongoClient = require('mongodb').MongoClient,
  api = new DigitalOceanAPI({
    token: process.env.DIGITAL_OCEAN_API_TOKEN
  }),
  storedState;


// Don't need to overthink this.  Our data model is a single 
// JSON document that will hold all the persistent state
q.ninvoke(mongoClient, 'connect', process.env.MONGOLAB_URI)
  .then((db) => {
    debugger;
    let coll = db.collection('data');

    return q.ninvoke(coll.find({ id: 'verifier-data'}), 'next')
      .then((stateDocument) => {
        if (!stateDocument) {
          let initialState = { id: 'verifier-data', droplets: [] };
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
    debugger;
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
                           debugger;
                           return verifyBackupsForDroplet(droplet).nodeify(cb);
                         });
      })
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
  debugger;
  // For each droplet gather up the unverified backups and verify them one by one
  return q.ninvoke(api, 'listDropletBackups', droplet.id)
    .then((backups) => {
      let backupsToVerify = backups.filter((backup) => !storedDroplet.backups.some((storedBackup) => backup.id === storedBackup.id && storedBackup.verified));
      
      return q.ninvoke(async, 'forEachSeries', backupsToVerify,
                       (backup, cb) => {
                         return verifyBackup(backup, droplet).nodeify(cb);
                       });
    })
    .catch((err) => {
      debugger;
    })
}

function verifyBackup(backup, droplet) {
  debugger;
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
      return waitUntilActive(createResponse.id);
    })
    .catch((err) => {
      debugger;
    });
}

function waitUntilActive(dropletId) {
  return q.ninvoke(api, 'getDroplet', dropletId)
    .then((droplet) => {
      if (!droplet.status === 'new') {
        console.log(`droplet (${dropletId}) status is still 'new'.  Waiting a minute...`);
        // Wait for a minute before checking again
        return q.delay(60000)
          .then(() => { return waitUntilActive(dropletId); });
      } else {
        console.log(`droplet (${dropletId}) status is now ${droplet.status}.`);
        return dropletId;
      }
    });
}
 setInterval(() => { console.log('heartbeat!');}, 1000);
