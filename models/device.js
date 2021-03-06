'use strict'
const fs = require('fs');
const async = require('async');

const db = require('../modules/db');
const mixin = require('./mixin');
const protocols = fs.readdirSync('./protocols').reduce((r, f) => {r[f] = require('../protocols/' + f); return r;}, {});
const nmap = require('../modules/nmap');
const history = require('../modules/history');
const events = require('../modules/events');
const Varbind = require('./varbind');

let timers = {};

Object.assign(Device, mixin.get('device'), {cache: cacheAll, getValue, getIpList, updateLatencies, getHistoryByTag, getTagList});

function cacheAll (callback) {
	async.series([
			(callback) => db.all('select * from devices', callback),
			(callback) => db.all('select * from varbinds', callback),
			(callback) => db.all('select * from checks', callback)
		], 
		function(err, results) {
			if (err)
				return callback(err);

			let device_list = results[0];
			let varbind_list = results[1];
			let check_list = results[2];

			// Varbinds with check_id don't have any props
			// Set them by appropriate check
			let checks = {};
			check_list.forEach((r) => checks[r.id] = r);

			let columns = varbind_list.length ? Object.keys(varbind_list[0]).filter((c) => c != 'id' && c != 'updated') : [];
			varbind_list.filter((r) => !!r.check_id && checks[r.check_id]).forEach(function(r) {
				let check = checks[r.check_id];
				columns.filter((c) => check[c] != undefined).forEach((c) => r[c] = check[c]);
			});

			varbind_list.forEach((r) => (new Varbind(r)).cache());
			device_list.forEach((r) => (new Device()).setAttributes(r).cache().updateVarbindList().updateStatus());

			async.eachSeries(Device.getList(), db.checkHistoryTable, callback);
		}
	)
}

function getIpList (is_pinged) {
	return Device.getList()
		.map((d) => !is_pinged || is_pinged && d.is_pinged ? d.ip : '')
		.map((ip) => (ip + '').trim())
		.filter((ip) => !!ip)
		.filter((e, idx, r) => r.indexOf(e) == idx); // unique
}

function updateLatencies (data, callback) {
	if (!data || !data.length)
		return callback();

	let odata = {};
	data.forEach((row) => odata[row.ip] = row);

	let columns = ['time'];
	let values = [new Date().getTime()];
	Device.getList().filter((d) => !!d.is_pinged).forEach(function(d, i) {
		let res = odata[d.ip] || data[i] && data[i].for == d.ip && data[i];
		if (!res || !d.is_pinged)
			return;

		d.alive = res.alive;
		d.latency = res.latency;

		columns.push('device' + d.id);
		let latency = res.latency;
		values.push(isNaN(latency) ? 'null' : latency);

		if (!d.is_status) {
			let prev_prev_status = d.prev_status;
			d.prev_status = d.status;
			d.status = res.alive ? 1 : (device.force_status_to || 3);
			events.emit('status-updated', d);
			if (prev_prev_status != undefined && d.prev_status != d.status)
				events.emit('status-changed', d, 'ping');
		}
	})

	db.run(`insert into history.latencies ("${columns.join('","')}") values (${values.join(',')})`, callback);
}

// Return object: keys is device tag, values is array of varbind tags
function getTagList () {
	let tags = {All: []};
	let device_list = Device.getList();
	device_list.forEach((d) => d.is_pinged && d.tag_list.forEach((tag) => tags[tag] = ['latency']));
	device_list.forEach(function(d) {
		d.tag_list.filter((tag) => tag[0] != '$').forEach(function(tag) {
			if (!tags[tag])
				tags[tag] = [];

			d.varbind_list.filter((v) => v.value_type == 'number' && !v.is_temporary).forEach((v) => tags[tag].push.apply(tags[tag], v.tag_list || []));
		})

		if (d.tag_list.length == 0)
			d.varbind_list.filter((v) => v.value_type == 'number' && !v.is_temporary).forEach((v) => tags.All.push.apply(tags.All, v.tag_list || []));
	});

	for (let tag in tags)
		if (tags[tag].length == 0 && tag != 'All')
			delete tags[tag];	

	for (let tag in tags)
		tags.All.push.apply(tags.All, tags[tag]);

	for (let tag in tags) 
		tags[tag] = tags[tag].filter((t, idx, tags) => tags.indexOf(t) == idx);
	
	return tags;
}

function getHistoryByTag(tag, device_tags, period, downsample, callback) {
	let device_list = Device.getList();
	let device_tag_list = (device_tags || '').split(';');

	if (device_tag_list.length && device_tag_list.indexOf('All') == -1) {
		device_list = device_list.filter((d) => device_tag_list.some(function (tag) {
			let re = new RegExp('\\b' + tag + '\\b');
			return re.test(d.tag_list.join(' '))
		}));
	}

	if (!device_list.length)	
		return callback(new Error('Device list is empty')); 

	if (tag == 'latency')
		return history.getLatency(device_list.filter((d) => d.is_pinged).map((d) => new Object({id: d.id, name: d.name})), period, downsample, callback);

	let dl = device_list.map(function (d) {
		let varbind_list = d.varbind_list.filter((v) => v.tag_list.indexOf(tag) != -1 && v.value_type == 'number' && !v.is_temporary).map((v) => new Object({id: v.id, name: v.name})); 
		return {id: d.id, name: d.name, varbind_list};
	});

	history.get(dl, period, downsample, callback);
}

function getValue(opts, callback) {
	if (!opts.address)	
		return callback(new Error('Address is empty'));

	if (opts.protocol == 'expression') {
		let device = Device.get(opts.device_id);
		if (!device)	
			return callback(new Error('Bad device id'));

		let res;
		try {
			let expressionCode = Varbind.generateExpressionCode(device, opts.address && opts.address.expression);
			res = eval(expressionCode);
			res = applyDivider(res, opts.divider);
		} catch (err) {
			res = 'ERR: ' + err.message;
		}
		return callback(null, res);
	}	 

	if (!opts.protocol || !protocols[opts.protocol])
		return callback(new Error('Unsupported protocol'));

	protocols[opts.protocol].getValues(opts.protocol_params, [opts.address], function(err, res) {
		callback(null, (err) ? 'ERR: ' + err.message : (res[0].isError) ? 'ERR: ' + res[0].value : applyDivider(res[0].value, opts.divider));
	})
}

function Device() {
	this.__type__ = 'device';
	this.varbind_list = [];
	this.status = 0;
	Object.defineProperty(this, 'is_status', {get: () => this.varbind_list.some((v) => v.is_status)});
}

Device.prototype.setAttributes = function (data) {
	if (this.template)
		delete data.template;

	Object.assign(this, data);
	if (this.id) 
		this.id = parseInt(this.id);

	['name', 'ip', 'mac', 'description'].forEach((prop) => this[prop] = (this[prop] || '').trim());
	this.timeout = parseInt(this.timeout) || 3;

	try {
		this.protocols = JSON.parse(data.json_protocols) || {};
		delete this.protocols.expression;
		for (let protocol in this.protocols)
			this.protocols[protocol].timeout = this.timeout;
	} catch (err) {
		this.json_protocols = '{}';
		this.protocols = {};
		console.error(__filename, err);
	}

	if (!this.json_varbind_list)
		this.json_varbind_list = '[]';

	this.tag_list = !!this.tags ? this.tags.toString().split(';').map((t) => t.trim()).filter((t, idx, tags) => tags.indexOf(t) == idx) : [];
	this.tags = this.tag_list.join(';');
	this.is_pinged = parseInt(this.is_pinged);
		
	return this;
}

Device.prototype.cache = mixin.cache;

Device.prototype.updateStatus = function () {
	this.prev_status = this.status;
	this.status = (this.is_status) ? this.varbind_list.reduce((max, e) => Math.max(max, e.status || 0), 0) : this.status;
	return this;
}

Device.prototype.updateVarbindList = function () {
	let collator = new Intl.Collator();
	this.varbind_list = mixin.get('varbind').getList().filter((v) => v.device_id == this.id).sort(collator.compare) || [];
	return this;
}

Device.prototype.getHistory = function (period, downsample, callback) {
	let varbind_list = this.varbind_list.filter((v) => v.value_type == 'number' && !v.is_temporary).map((v) => new Object({id: v.id, name: v.name}));
	history.get([{id: this.id, name: this.name, varbind_list}], period, downsample, callback);
}

Device.prototype.getChanges = function (period, callback) {
	let device = this;
	let from = period[0];
	let to = period[1];
	let ids = device.varbind_list.filter((v) => v.value_type != 'number' && !v.is_temporary).map((v) => v.id).join(', ');

	db.all(
		`select start_date, end_date, varbind_id, prev_value, value, status from changes.device${device.id} where varbind_id in (${ids}) and (
			start_date <= ${from} and (end_date >= ${from} or end_date is null) or 
			start_date >= ${from} and (end_date <= ${to} or end_date is null) or 
			start_date <= ${to} and (end_date >= ${to} or end_date is null))`, 
		function (err, rows) {
			if (err)
				return callback(err);
	
			let time = new Date().getTime();	
			let res = rows.map((row) => [row.start_date, row.end_date || time, row.varbind_id, row.prev_value, row.value, row.status]);
			callback(null, res);
		}
	);
}

Device.prototype.updateParent = function (callback) {
	let device = this;
	if (!device.ip) {
		device.parent_id = null;
		return callback(null, null);		
	}

	nmap.route(device.ip, function(err, ips) {
		let res;
		Device.getList().forEach(function(d) {
			let hop = ips.indexOf(d.ip);
			if (hop == -1)
				return;
	
			if (!res || res.hop < hop && device.ip != d.ip && d.is_pinged)
				res = {hop, parent: d};
		});
	
		let parent = res && res.parent || null;
		let parent_id = parent ? parent.id : null;
		db.run('update devices set parent_id = ? where id = ?', [parent_id, device.id], function (err) {
			if (err) 
				return callback(err);
	
			device.parent_id = parent_id;
			callback(null, parent);
		});
	})
}

Device.prototype.polling = function (delay) {
	let device = this;
	
	if (timers[device.id]) {
		clearTimeout(timers[device.id]);
		delete timers[device.id];
	}

	if (!device.varbind_list || device.varbind_list.length == 0)
		return;

	if (delay)
		return timers[device.id] = setTimeout(() => device.polling(), delay);

	let values = {};
	let errors = [];
	async.eachOfSeries(protocols, function(protocol, protocol_name, callback) {
			let opts = device.protocols[protocol_name];
			let varbind_list = device.varbind_list.filter((v) => v.protocol == protocol_name);
			let address_list = varbind_list.map((v) => v.address);

			if (address_list.length == 0 || !opts)
				return callback();

			opts.ip = device.ip;	
			protocol.getValues(opts, address_list, function(err, res) {
				errors.push(err);
				varbind_list.forEach((v, i) => values[v.id] = (err) ? {isError: true, value: err.message} : res[i]);
				callback();
			})
		}, 
		function (err) {
			let time = new Date().getTime();

			function update (varbind) {
				let value = (varbind.is_expression) ? varbind.calcExpressionValue() : values[varbind.id].value;
				let isError = varbind.is_expression && value instanceof Error || !varbind.is_expression && values[varbind.id].isError;
				value = (isError) ? 'ERR: ' + value : applyDivider (value, varbind.divider);

				varbind.prev_value = varbind.value;
				varbind.value = value;
				varbind.updateStatus();			

				for(let i in varbind.stores) 
					varbind.stores[i].push(varbind.value);

				varbind.prev_value_time = varbind.value_time;
				varbind.value_time = time;
			}

			device.varbind_list.filter((v) => values[v.id] !== undefined && !v.is_expression).forEach(update);
			device.varbind_list.filter((v) => v.is_expression).forEach(update);

			device.varbind_list
				.filter((v) => !v.is_temporary && (v.value != v.prev_value || v.status != v.prev_status))
				.forEach(function (v) {
					let sql = 'update varbinds set value = ?, prev_value = ?, status = ? where id = ?'; 
					let params = [v.value, v.prev_value, v.status || 0, v.id];
					db.run(sql, params, (err) => (err) ? console.log(__filename, err, {sql, params}) : null);
				});

			events.emit('values-updated', device, time);

			let isError = errors.every((e) => e instanceof Error);
			device.alive = !isError;

			if (isError) {
				device.prev_status = device.status;
				device.status = device.force_status_to;
			} else {
				device.updateStatus();
			}	 

			events.emit('status-updated', device, time);

			if (device.prev_status != device.status) {
				let reason = isError ? 
					errors.map((e) => e.message).join(';') :
					device.varbind_list.filter((v) => v.is_status && v.status == device.status).map((v) => v.name + ': ' + v.value).join(';');
				events.emit('status-changed', device, time, reason);
			}
	
			let query_list = [];
			let params_list = [];

			// number
			let columns = ['time'];
			let params = [time];
			let varbind_list = device.varbind_list.filter((v) => !v.is_temporary && v.value_type == 'number');

			varbind_list.forEach(function(v) {
				columns.push(`varbind${v.id}`);
				params.push(`${v.value || null}`);

				if (!v.status)
					return;
				columns.push(`varbind${v.id}_status`);			
				params.push(`${v.status}`);
			});

			query_list.push(`insert into history.device${device.id} (${columns.join(',')}) values (${'?, '.repeat(columns.length - 1) + '?'})`);
			params_list.push(params);

			// Other types
			device.varbind_list
				.filter((v) => !v.is_temporary && v.value_type != 'number' && v.prev_value != v.value)
				.forEach(function(v) {
					if (v.value_type == 'duration' && !isNaN(v.prev_value) && !isNaN(v.value) && (v.value - v.prev_value) > 0)
						return;

					query_list.push(`update changes.device${device.id} set end_date = ? where varbind_id = ? and end_date is null`);
					params_list.push([time - 1, v.id]);

					query_list.push(`insert into changes.device${device.id} (varbind_id, prev_value, value, status, start_date) values (?, ?, ?, ?, ?)`);
					params_list.push([v.id, v.value_type == 'duration' ? v.prev_value : null, v.value || null, v.status, time]);
				});

			async.eachOfSeries(
				query_list, 
				(query, idx, callback) => db.run(query, params_list[idx], callback), 
				(err) => (err) ? console.error(__filename, query, params_list[idx], err) : null
			);
	
			device.polling(device.period * 1000 || 60000);
		}
	) 
}

Device.prototype.delete = function (callback) {
	let device = this;
	async.series([
			(callback) => db.run('begin transaction', callback),
			(callback) => db.run('delete from varbinds where device_id = ?', [device.id], callback),
			(callback) => db.run('delete from devices where id = ?', [device.id], callback),
			(callback) => db.run('commit transaction', callback)
		],
		function(err) {
			if (err) 
				return db.run('rollback transaction', (err2) => callback(err));
		
			device.varbind_list.forEach((varbind) => varbind.cache('CLEAR'));
			device.varbind_list = [];
			device.polling();
			device.cache('CLEAR');

			function drop(where, callback) {
				db.run(`drop table ${where}.device${device.id}`, function (err) {
					if (err)
						console.error(__filename, err.message);
					callback();
				})
			}

			async.eachSeries(['history', 'changes'], drop, callback);
		}
	)
}

Device.prototype.save = function (callback) {
	let device = this;
	let isNew = !this.id; 
	let time = new Date().getTime();

	let varbind_list = [];
	let delete_varbind_ids = [];
	
	async.series ([
		function (callback) {
			db.run('begin transaction', callback);
		},

		function (callback) {
			db.upsert(device, ['name', 'description', 'tags', 'ip', 'mac', 'json_protocols', 'is_pinged', 'period', 'timeout', 'force_status_to', 'template'], callback);
		},

		function (callback) {
			try {
				varbind_list = JSON.parse(device.json_varbind_list).map(function (v) {
					if (isNew && v.id)
						delete v.id;
					v.name = v.name || 'Unnamed';
					v.device_id = device.id;
					v.updated = time;
					return new Varbind(v);
				});
				delete device.json_varbind_list;
			} catch (err) {
				return callback(err);
			}

			async.eachSeries(
				varbind_list, 
				(varbind, callback) => db.upsert(varbind, ['device_id', 'name', 'protocol', 'json_address', 'divider', 'value_type', 'json_status_conditions', 'tags', 'updated'], callback), 
				callback
			);
		},

		function (callback) { 
			let sql = 'select id from varbinds where device_id = ? and updated <> ? and check_id is null';
			let params = [device.id, time];
			db.all(sql, params, function (err, rows) {
				if (err)
					return callback(err);

				rows.forEach((r) => delete_varbind_ids.push(r.id));
				callback();
			});
		},

		function (callback) { 
			db.run(`delete from varbinds where id in (${delete_varbind_ids.join()})`, callback);
		},

		function (callback) {
			db.run('commit transaction', callback); 
		}
	], function(err) {
		if (err) 
			return db.run('rollback transaction', (err2) => callback(err));

		device = device.cache();

		delete_varbind_ids.forEach((id) => Varbind.get(id).cache('CLEAR'));
		varbind_list.forEach((v) => v.cache());
		device.updateVarbindList();
		device.prev_status = 0;
		device.status = 0;

		if (!!device.parent_id)
			device.updateParent((err) => (err) ? console.error(err) : null);

		if (isNew)
			db.run(`alter table history.latencies add column device${device.id} real`, (err) => null);

		db.checkHistoryTable(device, (err) => callback(err, device.id));
		device.polling(2000);
	});
}

Device.prototype.getParent = function () {
	return Device.get(this.parent_id);
}

// divider is a "number" or "number + char" or "number + r + regexp"
function applyDivider (value, divider) {
	if (typeof(value) === 'boolean')
		return value;

	if (isNaN(value)) {
		value += '';

		// Don't change error-values
		if (value.indexOf('ERR') == 0)
			return value;

		// Force to number
		let comma_count = (value.match(/,/g) || []).length;
		let point_count = (value.match(/\./g) || []).length;
		if (point_count == 0 && comma_count == 1) // '123,4' to 123.4
			return applyDivider(parseFloat(value.replace(',', '.')), divider);

		if (point_count == 1 && comma_count > 0) // '1,234.5' to 1234.5
			return applyDivider(parseFloat(value.replace(',', '')), divider);
	}

	// Extract and apply regexp, e.g 123rMemory(\d+)
	if (isNaN(value) && isNaN(divider)) {
		value += '' 
		divider += '';
		let pos = divider.indexOf('r'); 
 
		if (pos == -1)		
			return value;

		let re, error, val;
		try {
			re = new RegExp(divider.substring(pos + 1));
			val = (value + '').match(re);
		} catch (err) {
			error = err;
		}
		
		return (error) ? error.message : val && val[1] ? applyDivider(val[1], parseFloat(divider)) : '';
	}	

	if (!value || isNaN(value) || !divider) 
		return value;

	let div = parseFloat(divider);
	let val = parseFloat(value) / div;
	
	if (div == divider)
		return val;

	let lastChar = divider.slice(-1);
	if (lastChar == 'C')
		return (val - 32) * 5 / 9; // Convert Fahrenheit to Celsius

	if (lastChar == 'F')
		return val * 9 / 5 + 32; // Convert Celsius to Fahrenheit

	if (lastChar == 'R') 
		return +val.toFixed(2); // round to .xx

	return val;
}

module.exports = Device;