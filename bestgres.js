var Transaction = require('pg-transaction');
var async = require('async');

var _client;

var bestgres = module.exports = {};

/********************** Util **********************/

/* general rollback function for any db wrapper method involving transactions
 * simply pass the local `tx` variable from the method and include a `virgin` savepoint
 */

function rollback(tx, callback) {
	return function(err, val) {
		if (err) {
			tx.rollback('virgin', function(e) {
				callback(err);
			});
		} else {
			tx.commit(function() {
				callback(null, val);
			});
		}
	};
}

/* given an array of functions, return a function accepting an object
 * with search parameter values that returns a single WHERe clause string
 */
function chain() {
	var fns = [].slice.call(arguments);
	return function(obj) {
		return fns.reduce(function(memo, fn, i) {
			return memo + (i === 0 ? "" : "AND ") + fn(obj) + " ";
		}, '');
	};
}

/********************** API **********************/

bestgres.init = function(client) {
	_client = client;
};

/* variadic higher-order function that accepts both functions and arrays of functions
 * to be async.waterfall()'d together into a postgres transaction; it returns a db method
 * of signature {object, fn}
 * only pass a function that expects to be bound to the returned function's data parameter
 */

bestgres.newTransactionMethod = function() {
	var args = [].slice.call(arguments);
	return function(data, callback) {
		var tx = new Transaction(_client);
		var fns = args.reduce(function(fns, el) {
			return fns.concat(typeof el === 'function' ? el.bind(data)() : el);
		}, [
			function(cb) { tx.begin(cb); },
			function(result, cb) { tx.savepoint('virgin', cb); }
		])
			.concat([function(result, cb) { cb(null, this.returnValue); }])
			.map(function(fn) { return fn.bind(data); });
		async.waterfall(fns, rollback(tx, callback));
	};
};

/* wrap a callback in order to guard against property lookups on null */
bestgres.guard = function(cb, options) {
	options = options || { type : 'rows', onlyErr : false };
	var handlers = {
		rows : function(val) { return val ? val.rows : null; },
		first : function(val) { return val ? val.rows[0] : null; },
		count : function(val) { return val ? val.rowCount : null; },
		propFirst : function(val) { return val && val.rows[0] ? val.rows[0][options.prop] : null; },
		pluck : function(val) { return val.rows.map(function(obj) { return obj[options.prop]; }); },
		dynatable : function(val) {
			return val && val.rows[0]
				? { records : val.rows, queryRecordCount : val.rows.length, totalRecordCount : val.rows[0].total_count }
				: null;
		}
	};
	return function(err, result) {
		if (options.onlyErr) return cb(err);
		cb(err, handlers[options.type](result));
	};
};

/* store all the WHERE clause partial string generators */
var _conditions = {};

/* update the internal _conditions object with the supplied object */
bestgres.newConditions = function(obj) {
	for (var key in obj) _conditions[key] = obj[key];
};

/* pass an array of generators to chainConditions() given an array of strings */
bestgres.chainConditions = function(arr) {
	return chain.apply(null, arr.map(function(key) { return _conditions[key]; }));
};
