# digital-ocean-backup-verifier
Proves a DO backup is ok by creating a droplet from it and verifying it boots

## Required ENV VARS
`DIGITAL_OCEAN_API_TOKEN` - API token for Digital Ocean account
`MONGOLAB_URI` - URI for mongoDB instance where verification results are
stored


## Design

The backups verifier's design consists of 2 components:
* A script that performs backup verifications, persisting its results in
  MongoDB, intended to be run as a scheduled job: (verifyBackups.js)
* A simple express webservice that presents verification results for
  review by an administrator or consumption by a healthcheck dashboard
  or health monitor


