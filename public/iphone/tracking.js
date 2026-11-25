(function () {
  'use strict';
  var api = window.motrApi;
  var watch = null;
  var fix = null;
  var gps = false;
  var nearby = false;
  var ride = null;
  var wantedAwake = false;
  var screenLock = null;
  var lockPending = false;
  var leaving = false;
  var onChange;
  var onCells;
  var channels = { nearby: { token: null, lastSend: 0, version: 0 }, ride: { token: null, lastSend: 0, version: 0 } };

  function visible() { return !leaving && !document.hidden; }
  function fresh() { return fix && Date.now() - fix.timestamp < 10000 ? fix : null; }

  function emit(message) {
    if (onChange) onChange({ gps: gps, nearby: nearby, ride: ride, fix: fresh(), message: message, wake: Boolean(screenLock) });
  }

  function wakeSupported() { return navigator.wakeLock && typeof navigator.wakeLock.request === 'function'; }
  function needsWake() { return visible() && nearby && wantedAwake; }
  function syncWake() {
    if (!needsWake()) {
      if (screenLock) {
        var previous = screenLock;
        screenLock = null;
        previous.release().catch(function () {});
        emit();
      }
      return;
    }
    if (!wakeSupported() || screenLock || lockPending) return;
    lockPending = true;
    navigator.wakeLock.request('screen').then(function (lock) {
      lockPending = false;
      if (!needsWake()) { lock.release().catch(function () {}); return; }
      screenLock = lock;
      lock.addEventListener('release', function () {
        if (screenLock === lock) { screenLock = null; emit(); }
      });
      emit();
    }, function () { lockPending = false; emit(); });
  }

  function revoke(channel, token, rideId) {
    if (!token || !api.current()) return Promise.resolve();
    if (channel === 'nearby') return api.rpc('motr_nearby', { mode: 'stop', lease_id: token }, true).catch(function () {});
    return api.rpc('motr_share', { mode: 'stop', lease: token, ride_id: rideId }, true).catch(function () {});
  }

  function reset(channel, rideId) {
    var slot = channels[channel];
    var token = slot.token;
    slot.version++;
    slot.token = null;
    slot.lastSend = 0;
    if (channel === 'nearby' && onCells) onCells([]);
    return revoke(channel, token, rideId);
  }

  function publish(channel, sample) {
    var slot = channels[channel];
    var isNearby = channel === 'nearby';
    var rideId = ride;
    var active = isNearby ? nearby : rideId;
    if (!active || !api.current() || slot.pending || Date.now() - slot.lastSend < 3500) return;
    var version = slot.version;
    slot.lastSend = Date.now();
    slot.pending = true;
    var coords = sample.coords;
    function canPublish() {
      return slot.version === version && visible() && Boolean(fresh()) && (isNearby ? nearby : ride === rideId);
    }
    var request;
    if (isNearby) {
      request = api.rpc('motr_nearby', {
        mode: slot.token ? 'update' : 'start', lease_id: slot.token,
        lat: Math.round(coords.latitude * 400), lon: Math.round(coords.longitude * 400)
      }, false, canPublish).then(function (data) {
        if (slot.version !== version || !visible() || !nearby) return revoke(channel, data.lease);
        slot.token = data.lease;
        if (onCells) onCells(data.cells || []);
        emit('Nearby Discovery is live.');
      });
    } else {
      request = (slot.token ? Promise.resolve(slot.token) : api.rpc('motr_share', { mode: 'start', ride_id: rideId }, false, canPublish))
        .then(function (lease) {
          if (slot.version !== version || !visible() || ride !== rideId) return revoke(channel, lease, rideId);
          slot.token = lease;
          return api.rpc('motr_share', { mode: 'position', ride_id: rideId, lease: lease, lat: coords.latitude, lon: coords.longitude }, false, canPublish);
        });
    }
    request.catch(function (error) {
      if (slot.version !== version) return;
      if (channel === 'nearby' && onCells) onCells([]);
      if (/expired/i.test(error.message)) {
        slot.token = null;
        if (channel === 'ride') ride = null;
      }
      emit('Could not share location. ' + error.message);
    }).then(function () { slot.pending = false; });
  }

  function pulse() {
    if (!visible()) return;
    var sample = fresh();
    if (!sample || typeof sample.coords.accuracy !== 'number' || !isFinite(sample.coords.accuracy) ||
        sample.coords.accuracy < 0 || sample.coords.accuracy > 100) return;
    publish('nearby', sample);
    publish('ride', sample);
  }

  function syncWatch() {
    var active = visible() && (gps || nearby || ride);
    if (!active) {
      if (watch !== null) navigator.geolocation.clearWatch(watch);
      watch = null;
      fix = null;
      emit();
      return;
    }
    if (watch !== null || !navigator.geolocation) return;
    watch = navigator.geolocation.watchPosition(function (sample) {
      if (!visible() || watch === null) return;
      fix = sample;
      if (sample.coords.accuracy > 100) emit('GPS accuracy is too low to share.');
      else emit(nearby && !channels.nearby.token ? 'Updating Nearby Discovery…' : undefined);
      pulse();
    }, function (error) {
      fix = null;
      if (error.code === 1) {
        gps = false;
        nearby = false;
        var previousRide = ride;
        ride = null;
        reset('nearby');
        reset('ride', previousRide);
        syncWake();
        syncWatch();
      }
      emit(error.code === 1 ? 'Location access is off. Allow it in your iPhone settings.' : 'Waiting for a fresh GPS position.');
    }, { enableHighAccuracy: true, timeout: 16000, maximumAge: 0 });
    emit('Getting your location…');
  }

  function pause() {
    reset('nearby');
    reset('ride', ride);
    syncWatch();
    syncWake();
    emit('Location updates paused.');
  }

  document.addEventListener('visibilitychange', function () {
    if (!visible()) { pause(); return; }
    syncWatch();
    syncWake();
  });
  window.addEventListener('pagehide', function () { leaving = true; pause(); });
  window.addEventListener('pageshow', function () { leaving = false; syncWatch(); syncWake(); });
  window.setInterval(function () {
    if (visible() && (gps || nearby || ride)) {
      if (fix && !fresh()) { fix = null; if (onCells) onCells([]); emit('Waiting for a fresh GPS position.'); }
      pulse();
    }
  }, 3500);

  window.motrTracking = {
    init: function (change, cells) { onChange = change; onCells = cells; emit(); },
    gps: function (value) { gps = value; syncWatch(); emit(); },
    nearby: function (value) {
      nearby = value;
      if (!value) reset('nearby');
      syncWatch(); syncWake(); pulse(); emit();
    },
    sharing: function (id) {
      if (ride !== id) {
        reset('ride', ride);
        ride = id;
      }
      syncWatch(); pulse(); emit();
    },
    clearSharing: function () {
      nearby = false;
      var previousRide = ride;
      ride = null;
      syncWatch(); syncWake(); emit();
      return Promise.all([reset('nearby'), reset('ride', previousRide)]);
    },
    awake: function (value) { wantedAwake = value; syncWake(); emit(); },
    supported: function () { return Boolean(wakeSupported()); }
  };
}());
