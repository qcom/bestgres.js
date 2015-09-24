'use strict';

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

bestgres.transaction = function() {
	// transaction boilerplate
	var tx = new Transaction(_client);
	var preliminarySteps = [
		function(cb) { tx.begin(cb); },
		function(result, cb) { tx.savepoint('virgin', cb); }
	];

	// we're variadic, baby
	let args = [].slice.call(arguments);

	// arrays of steps can be passed, which will be concatenated, reduced, and waterfalled,
	// before generating any extra steps with passed in functions
	var passedSteps = args.filter((arg) => Array.isArray(arg)).reduce((memo, arr) => memo.concat(arr), []);
	var generatorFns = args.filter((arg) => typeof arg === 'function');

	return function(data, callback) {
		// join the passed steps with the boilerplate and bind all to the data parameter
		let steps = preliminarySteps.concat(passedSteps).map((fn) => fn.bind(data));

		// execute all steps passed as arrays before executing any dynamic generator function results
		async.waterfall(steps, function(err, result) {
			if (err) return callback(err);

			// bind all generator functions to the current value of the data parameter;
			// the positioning of this step was the reason for the new method,
			// as previously the data binding occurred too early; i.e. before any of the
			// array-based steps had a chance to alter the communal payload
			let dynamicSteps = generatorFns.map((fn) => fn.call(data)).reduce((memo, arr) => memo.concat(arr, []));

			let _keepItMoving = function(cb) {
				cb(null, null);
			};

			let _wrapItUp = function(result, cb) {
				cb(null, this.returnValue);
			};

			let finalSteps = [_keepItMoving].concat(dynamicSteps).concat([_wrapItUp.bind(data)]);

			async.waterfall(finalSteps, rollback(tx, callback));
		});
	};
};

/* wrap a callback in order to guard against property lookups on null */
bestgres.guard = function(cb, options) {
	options = options || { type : 'rows', onlyErr : false };
	var prop = options.prop;
	var handlers = {
		rows : function(val) { return val ? val.rows : null; },
		first : function(val) { return val ? val.rows[0] : null; },
		count : function(val) { return val ? val.rowCount : null; },
		propFirst : function(val) { return val && val.rows[0] ? val.rows[0][prop] : null; },
		pluck : function(val) { return val.rows.map(function(obj) { return obj[prop]; }); },
		dynatable : function(val) {
			return val && val.rows[0]
				? { records : val.rows, queryRecordCount : val.rows.length, totalRecordCount : val.rows[0].total_count }
				: null;
		},
		autocomplete : function(val) {
			if (!val || !val.rows[0]) return { suggestions : [] };
			return {
				suggestions: !prop ? val.rows : val.rows.map(function(obj) {
					return obj[prop];
				})
			};
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
