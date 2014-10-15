Bestgres is a collection of helpers and utilities to make some of the common postgres tasks less horrible!

##Installation

```
npm install bestgres
```

##Purpose

[node-postgres](https://github.com/brianc/node-postgres) is excellent and [pg-transaction](https://www.npmjs.org/package/pg-transaction) is of course even handier for transactions, but even a small number of database calls utilizing transactions will accumulate cruft quickly:

```javascript
function updateXandY(data, cb) {
	var tx = new Transaction(client);
	function onErr(err) {
		if (err) {
			tx.rollback('virgin', function(e) {
				cb(err);
			});
		} else {
			tx.commit(cb);
		}
	}
	tx.begin(function(err, result) {
		if (err) return cb(err);
		tx.savepoint('virgin', function(err, result) {
			if (err) return onErr(err);
			/* finally time to do something that isn't plumbing! */
			tx.query(updateX, data, function(err, result) {
				if (err) return onErr(err);
				tx.query(updateY, data, function(err, result) {
					if (err) return onErr(err);
					onErr(null);
				});
			});
		});
	});
}
```

This is postgres transactions in node at its worst. Not only are we fighting manual error handling, but there is the fear that the majority of this code will be duplicated should another transaction database call be required. Control flow can of course be alleviated with [async](https://github.com/caolan/async) which will absolve us of our nested sins:

```javascript
function updateXandY(data, cb) {
	var tx = new Transaction(client);
	async.waterfall([
		function (cb) { tx.begin(cb); },
		function (result, cb) { tx.savepoint('virgin', cb); },
		function (result, cb) { tx.query(updateX, data, cb); },
		function (result, cb) { tx.query(updateY, data, cb); }
	], updateXandY);
}
```

Phew! A bit cleaner to be sure, but `updateXandY` still needs to be defined somewhere, and having to tirelessly instantiate a `new Transaction` plus manually begin the transaction and create a generic savepoint will grow old. How about:

```javascript
var updateXandY = bestgres.newTransactionMethod([
	function(result, cb) { updateX(this, cb); },
	function(result, cb) { updateY(this, cb); }
]);
```

No more worrying about any tx objects, inline queries, or even error handling. The redunancy has been eliminate and now you can focus on the steps your transaction needs to take.

Because tx is unavailable and inline queries are thus impossible, bestgres encourages a modular query design where transactions depend on focused, individual queries that can be more easily tested.

`this` in your passed functions will be bound to the `data` parameter of the database method returned by `bestgre.newTransactionMethod`.
