(function () {
  'use strict';
  var api = window.motrApi;
  var tracking = window.motrTracking;
  var view;
  var currentRide;
  var currentFix;
  var currentTracking;
  var chatFriend;
  var map;
  var ownMarker;
  var nearbyMarkers;
  var rideMarkers;
  var firstFix = true;
  var noticeTimer;
  var verificationType;
  var verificationEmail;
  var recoverySession;
  var ridePoll = false;
  var chatPoll = false;
  var sessionUser;
  var linkedInvite;
  var trip;
  var tripHistory = api.read('motr-iphone-history-v1', []);
  var themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

  function el(id) { return document.getElementById(id); }
  function show(id, visible) { el(id).hidden = !visible; }
  function set(id, value) { el(id).textContent = value; }
  function value(id) { return el(id).value.trim(); }
  function explain(text) {
    set('notice', text);
    show('notice', Boolean(text));
    clearTimeout(noticeTimer);
    if (text) noticeTimer = setTimeout(function () { show('notice', false); }, 6500);
  }
  function failed(error) { explain(error.message || 'Try again when you have an internet connection.'); }
  function child(parent, tag, text, className) {
    var item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    parent.appendChild(item);
    return item;
  }
  function action(parent, title, run) {
    var button = child(parent, 'button', title, 'btn');
    button.type = 'button';
    button.addEventListener('click', run);
    return button;
  }
  function job(target, work) {
    if (target && target.disabled) return;
    if (target) target.disabled = true;
    Promise.resolve().then(work).catch(failed).then(function () { if (target) target.disabled = false; });
  }
  function submit(id, work) {
    var form = el(id);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      job(form.querySelector('button[type=submit],button:not([type])'), work);
    });
  }
  function click(id, work) { el(id).addEventListener('click', function () { job(this, work); }); }
  function initMap() {
    if (!window.L || map) return;
    map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: true }).setView([30.15, 70.25], 5);
    map.attributionControl.setPrefix(false);
    var tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
      maxZoom: 19, updateWhenIdle: true, keepBuffer: 1, referrerPolicy: 'strict-origin-when-cross-origin'
    }).addTo(map);
    tiles.on('tileerror', function () { if (view === 'map') set('connection', navigator.onLine ? 'Map limited' : 'Offline'); });
    nearbyMarkers = L.layerGroup().addTo(map);
    rideMarkers = L.layerGroup().addTo(map);
  }
  function markers(layer, items, tint, precision) {
    if (!layer) return;
    layer.clearLayers();
    items.forEach(function (point) {
      if (!isFinite(point[0]) || !isFinite(point[1])) return;
      if (precision) L.circle(point, { radius: 142, color: tint, weight: 1, fillOpacity: .2 }).addTo(layer);
      L.circleMarker(point, { radius: 6, color: '#fff', weight: 2, fillColor: tint, fillOpacity: .95 }).addTo(layer);
    });
  }
  function trackState(state) {
    currentTracking = state;
    currentFix = state.fix;
    el('nearby').checked = state.nearby;
    set('toggle-gps', state.gps ? 'Stop GPS' : 'Start GPS');
    set('ride-sharing', state.ride ? 'Stop location sharing' : 'Share my location');
    set('wake-status', state.wake ? 'Display stays awake while you use MOTR.' : '');
    var coords = state.fix && state.fix.coords;
    var reliable = coords && Number.isFinite(coords.accuracy) && coords.accuracy >= 0 && coords.accuracy <= 100;
    var speed = reliable && typeof coords.speed === 'number' && Number.isFinite(coords.speed) && coords.speed >= 0 ? Math.round(coords.speed * 3.6) : '—';
    set('speed', speed);
    trackTrip(state, reliable, speed);
    set('map-title', state.nearby ? 'Nearby Discovery' : state.ride ? 'Private ride' : reliable ? 'GPS active' : 'Ready to ride.');
    set('map-status', state.message || (state.nearby && reliable ? 'Sharing your approximate area.' : state.ride && reliable ? 'Sharing with your private ride.' : reliable ? 'Accuracy ±' + Math.round(coords.accuracy) + ' m.' : state.gps || state.nearby || state.ride ? 'Getting your location…' : 'GPS is off. Your location is private.'));
    if (map && reliable) {
      var location = [coords.latitude, coords.longitude];
      if (!ownMarker) ownMarker = L.circleMarker(location, { radius: 7, color: '#fff', weight: 2, fillColor: '#287cff', fillOpacity: 1 }).addTo(map);
      else ownMarker.setLatLng(location);
      if (firstFix) { firstFix = false; map.setView(location, 15, { animate: false }); }
    } else if (map && ownMarker) { map.removeLayer(ownMarker); ownMarker = null; }
  }
  function distance(previous, next) {
    var radians = Math.PI / 180;
    var deltaLat = (next.latitude - previous.latitude) * radians;
    var deltaLon = (next.longitude - previous.longitude) * radians;
    var square = Math.pow(Math.sin(deltaLat / 2), 2) +
      Math.cos(previous.latitude * radians) * Math.cos(next.latitude * radians) * Math.pow(Math.sin(deltaLon / 2), 2);
    return 12742000 * Math.asin(Math.sqrt(Math.min(1, square)));
  }
  function duration(seconds) {
    var value = Math.round(seconds);
    return Math.floor(value / 60) + ':' + ('0' + value % 60).slice(-2);
  }
  function stats(entry) {
    var average = entry.seconds > 0 ? (entry.meters / entry.seconds * 3.6).toFixed(1) : '—';
    return (entry.meters / 1000).toFixed(2) + ' km · ' + duration(entry.seconds) + ' · Avg ' + average + ' · Max ' + (entry.max === null ? '—' : entry.max) + ' km/h';
  }
  function renderHistory() {
    var list = el('trip-history');
    list.textContent = '';
    tripHistory.forEach(function (entry) {
      var row = child(list, 'div', undefined, 'row');
      var detail = child(row, 'span', new Date(entry.start).toLocaleString());
      detail.appendChild(document.createElement('br'));
      child(detail, 'small', stats(entry), 'muted');
      action(row, 'Delete', function () {
        if (!window.confirm('Delete this trip from this device?')) return;
        tripHistory = tripHistory.filter(function (item) { return item.start !== entry.start; });
        api.write('motr-iphone-history-v1', tripHistory);
        renderHistory();
      });
    });
  }
  function trackTrip(state, reliable, speed) {
    if (!state.gps) {
      if (trip && trip.samples > 1) {
        tripHistory.unshift({ start: trip.start, seconds: trip.seconds, meters: trip.meters, max: trip.max });
        tripHistory = tripHistory.slice(0, 50);
        api.write('motr-iphone-history-v1', tripHistory);
        renderHistory();
      }
      trip = null;
      set('trip-summary', 'Start GPS on the map to record a trip on this device.');
      return;
    }
    if (!trip) trip = { start: Date.now(), seconds: 0, meters: 0, max: null, samples: 0, last: null };
    if (!reliable) { trip.last = null; return; }
    var fix = state.fix;
    if (trip.last && fix.timestamp <= trip.last.timestamp) return;
    if (trip.last) {
      var elapsed = (fix.timestamp - trip.last.timestamp) / 1000;
      var meters = distance(trip.last.coords, fix.coords);
      if (elapsed <= 10) {
        trip.seconds += elapsed;
        if (meters >= 5 && meters / elapsed < 100 && trip.last.coords.accuracy <= 45 && fix.coords.accuracy <= 45) trip.meters += meters;
      }
    }
    if (speed !== '—') trip.max = Math.max(trip.max === null ? speed : trip.max, speed);
    trip.samples++;
    trip.last = fix;
    set('trip-summary', 'Recording · ' + stats(trip));
  }
  function showView(name) {
    if (['map', 'rides', 'garage', 'profile', 'settings'].indexOf(name) === -1) name = 'map';
    if (name === view) return;
    view = name;
    reflectNetwork();
    ['map', 'rides', 'garage', 'profile', 'settings'].forEach(function (item) { show('view-' + item, item === view); });
    Array.prototype.forEach.call(document.querySelectorAll('.nav [data-view]'), function (link) {
      if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    if (view === 'map') {
      initMap();
      if (map) { map.invalidateSize(false); if (currentTracking) trackState(currentTracking); }
      if (!window.L) set('map-status', 'Map library unavailable. Check your connection and reload.');
    }
    if (!sessionUser) return;
    if (view === 'rides') readRides().catch(failed);
    if (view === 'garage') loadGarage().catch(failed);
    if (view === 'profile') loadProfile().catch(failed);
  }
  function navigate(name) {
    if (location.hash !== '#' + name) location.hash = name;
    showView(name);
  }
  function account() {
    var active = api.current();
    sessionUser = active && active.user;
    ['ride-content', 'garage-content', 'account-content'].forEach(function (id) { show(id, Boolean(sessionUser)); });
    show('auth-content', !sessionUser);
    Array.prototype.forEach.call(document.querySelectorAll('.sign-gate'), function (gate) { gate.hidden = Boolean(sessionUser); });
    if (!sessionUser) {
      currentRide = null;
      chatFriend = null;
      show('ride-detail', false);
      el('rides-list').textContent = '';
      el('messages').textContent = '';
      el('friends').textContent = '';
      return;
    }
    set('rider-email', sessionUser.email || '');
    if (view === 'profile') loadProfile().catch(failed);
    if (view === 'garage') loadGarage().catch(failed);
    if (view === 'rides') readRides().catch(failed);
    if (linkedInvite) { el('invite').value = linkedInvite; linkedInvite = null; navigate('rides'); }
  }
  function emailEntered() {
    var email = el('email');
    if (!email.checkValidity()) { email.focus(); throw new Error('Enter a valid email address.'); }
    return email.value.trim();
  }
  function startVerify(type, email) {
    verificationType = type;
    verificationEmail = email;
    el('password').value = '';
    el('verification-code').value = '';
    show('verify-form', true);
    el('verification-code').focus();
    explain('Check your email for the MOTR verification code.');
  }
  submit('auth-form', function () {
    return api.signIn(emailEntered(), el('password').value).then(function () {
      el('password').value = '';
      show('verify-form', false);
      account();
      navigate('map');
    });
  });
  click('sign-up', function () {
    var email = emailEntered();
    var password = el('password').value;
    if (password.length < 8) throw new Error('Enter a password with at least 8 characters.');
    return api.signUp(email, password).then(function (active) {
      if (active) { el('password').value = ''; account(); navigate('map'); }
      else startVerify('signup', email);
    });
  });
  click('forgot-password', function () {
    var email = emailEntered();
    return api.recover(email).then(function () { startVerify('recovery', email); });
  });
  submit('verify-form', function () {
    var code = value('verification-code');
    if (!/^\d{6,10}$/.test(code)) throw new Error('Enter the code from your email.');
    return api.verify(verificationEmail, code, verificationType).then(function (data) {
      el('verification-code').value = '';
      show('verify-form', false);
      if (verificationType === 'recovery') { recoverySession = data; show('reset-form', true); }
      else { account(); navigate('map'); }
    });
  });
  submit('reset-form', function () {
    if (!recoverySession) throw new Error('Request a new password reset code.');
    return api.reset(el('new-password').value, recoverySession).then(function () {
      recoverySession = null;
      el('new-password').value = '';
      show('reset-form', false);
      account();
      explain('Password updated.');
    });
  });
  click('sign-out', function () {
    var stop = tracking.clearSharing();
    return Promise.race([stop, new Promise(function (resolve) { setTimeout(resolve, 1500); })])
      .then(api.signOut).then(function () { account(); explain('Signed out.'); });
  });

  function rideName(ride) { return ride.group_name || 'Private ride'; }
  function readRides() {
    var user = sessionUser;
    return api.rpc('motr_ride_spaces').catch(function (error) {
      if (error.code === 'PGRST202') return api.rpc('motr_my_rides');
      throw error;
    }).then(function (rides) {
      if (user !== sessionUser) return;
      var list = el('rides-list');
      list.textContent = '';
      if (!rides || !rides.length) { child(list, 'p', 'No rides yet. Create a ride or enter an invite.', 'muted'); return; }
      rides.forEach(function (ride) {
        var row = child(list, 'div', undefined, 'row');
        child(row, 'span', rideName(ride) + ' · ' + (ride.member_count || 1) + ' riders');
        action(row, 'Open', function () { selectRide(ride); });
      });
    });
  }
  function selectRide(ride) {
    if (currentRide && currentRide.id !== ride.id) tracking.sharing(null);
    currentRide = ride;
    chatFriend = null;
    el('messages').textContent = '';
    show('ride-detail', true);
    show('group-plan', false);
    show('copy-invite', Boolean(ride.invite));
    show('leave-ride', !ride.invite);
    show('end-ride', Boolean(ride.invite));
    show('ride-sharing', true);
    set('ride-title', rideName(ride));
    set('ride-meta', '');
    set('ride-plan', '');
    refreshRide();
    readMessages();
  }
  function refreshRide() {
    if (!currentRide || chatFriend || ridePoll || document.hidden || !(view === 'map' || view === 'rides')) return;
    var id = currentRide.id;
    ridePoll = true;
    Promise.all([api.rpc('motr_roster', { ride_id: id }), api.rpc('motr_ride_plan', { ride_id: id })])
      .then(function (results) {
        if (!currentRide || currentRide.id !== id || document.hidden) return;
        var roster = results[0] || [];
        var plan = results[1] && results[1][0];
        markers(rideMarkers, roster.filter(function (row) { return row.rider !== sessionUser.id && row.sharing && row.latitude !== null && row.longitude !== null; }).map(function (row) { return [row.latitude, row.longitude]; }), '#e64255', false);
        set('ride-meta', roster.length + (roster.length === 1 ? ' rider' : ' riders'));
        if (plan) {
          set('ride-plan', [plan.meeting_place, plan.departure_at ? new Date(plan.departure_at).toLocaleString() : '', plan.ride_rules].filter(Boolean).join(' · '));
          if (el('group-plan').hidden && plan.can_edit) {
            el('group-place').value = plan.meeting_place || '';
            el('group-rules').value = plan.ride_rules || '';
          }
          show('group-plan', Boolean(plan.can_edit));
        }
      }).catch(function () { markers(rideMarkers, [], '', false); })
      .then(function () { ridePoll = false; });
  }
  function changeRide(mode, code) {
    return api.rpc('motr_ride', { mode: mode, code: code || null }).then(function (ride) { selectRide(ride); return readRides(); });
  }
  function extractInvite(input) {
    var matches = input.match(/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/i);
    if (!matches) throw new Error('Enter a valid MOTR invite code.');
    return matches[0];
  }
  click('refresh-rides', readRides);
  click('new-ride', function () { return changeRide('create'); });
  submit('join-ride', function () { return changeRide('join', extractInvite(value('invite'))).then(function () { el('invite').value = ''; }); });
  submit('new-group', function () {
    var name = value('group-name');
    return api.rpc('motr_create_group', { name: name, avatar: 'helmet' }).then(function (ride) {
      ride.group_name = name;
      el('group-name').value = ''; selectRide(ride); return readRides();
    });
  });
  submit('group-plan', function () {
    if (!currentRide) return;
    var departure = value('group-time');
    return api.rpc('motr_save_ride_plan', { ride_id: currentRide.id, place: value('group-place'), rules: value('group-rules'),
      departure: departure ? new Date(departure).toISOString() : null, meeting_url: null }).then(function () { explain('Ride plan saved.'); refreshRide(); });
  });
  click('copy-invite', function () {
    if (!currentRide || !currentRide.invite) return;
    var invite = location.origin + location.pathname + '?join=' + currentRide.invite;
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(invite).then(function () { explain('Invite copied.'); }, function () { window.prompt('Copy this private ride invite', invite); });
    window.prompt('Copy this private ride invite', invite);
  });
  click('ride-sharing', function () {
    if (currentRide) tracking.sharing(currentTracking && currentTracking.ride ? null : currentRide.id);
  });
  function closeRide(ending) {
    if (!currentRide || !window.confirm(ending ? 'End this ride for everyone?' : 'Leave this private ride?')) return;
    var id = currentRide.id;
    tracking.sharing(null);
    var request = ending ? api.rpc('motr_end_ride', { ride_id: id }) : api.rpc('motr_share', { ride_id: id, mode: 'leave' });
    return request.then(function () {
      if (currentRide && currentRide.id === id) { currentRide = null; show('ride-detail', false); markers(rideMarkers, [], '', false); }
      return readRides();
    });
  }
  click('end-ride', function () { return closeRide(true); });
  click('leave-ride', function () { return closeRide(false); });

  function thread() { return chatFriend ? chatFriend.id : currentRide && currentRide.id; }
  function readMessages() {
    var id = thread();
    if (!id || !sessionUser || chatPoll || document.hidden || view !== 'rides') return;
    var direct = Boolean(chatFriend);
    chatPoll = true;
    return api.rpc(direct ? 'motr_friend_messages' : 'motr_chat_messages_named', direct ? { target: id } : { ride_id: id })
      .then(function (messages) {
        if (id !== thread() || !sessionUser) return;
        var list = el('messages');
        var signature = (messages || []).map(function (message) { return message.id; }).join(',');
        if (list.dataset.signature === signature && list.childNodes.length) return;
        list.dataset.signature = signature;
        list.textContent = '';
        if (!messages || !messages.length) { child(list, 'p', 'No messages yet.', 'muted'); return; }
        messages.slice().reverse().forEach(function (message) {
          var block = child(list, 'div', undefined, 'message');
          child(block, 'strong', message.sender === sessionUser.id ? 'You' : message.sender_label || 'Rider');
          child(block, 'p', message.body);
        });
        list.scrollTop = list.scrollHeight;
      }).catch(function (error) {
        if (id === thread()) set('messages', 'Chat unavailable. ' + error.message);
      }).then(function () { chatPoll = false; });
  }
  submit('chat-form', function () {
    var id = thread();
    var body = value('chat-message');
    if (!id || !body) return;
    var request = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(18)), function (part) { return ('0' + part.toString(16)).slice(-2); }).join('');
    var args = { message_body: body, client_request_id: request };
    args[chatFriend ? 'target' : 'ride_id'] = id;
    return api.rpc(chatFriend ? 'motr_friend_send' : 'motr_chat_send', args).then(function () {
      if (thread() === id && value('chat-message') === body) el('chat-message').value = '';
      return readMessages();
    });
  });

  function showFriendChat(friend) {
    chatFriend = friend;
    show('ride-detail', true);
    show('copy-invite', false);
    show('ride-sharing', false);
    show('leave-ride', false);
    show('end-ride', false);
    show('group-plan', false);
    el('messages').textContent = '';
    set('ride-title', friend.display_name || friend.username_handle || 'Rider');
    set('ride-meta', 'Direct message');
    set('ride-plan', '');
    navigate('rides');
    readMessages();
  }
  function renderFriends(friends, empty) {
    var list = el('friends');
    list.textContent = '';
    if (!friends.length) { child(list, 'p', empty, 'muted'); return; }
    friends.forEach(function (friend) {
      var row = child(list, 'div', undefined, 'row');
      child(row, 'span', friend.display_name || friend.username_handle || 'Rider');
      var buttons = child(row, 'div', undefined, 'form-actions');
      if (friend.relationship === 'friend' || friend.relationship === 'friends') {
        action(buttons, 'Message', function () { showFriendChat(friend); });
      } else if (friend.relationship === 'received') {
        action(buttons, 'Accept', function () { job(this, function () { return changeFriend(friend, 'accept'); }); });
      } else if (friend.relationship === 'sent') {
        child(buttons, 'small', 'Requested', 'muted');
      } else if (friend.id !== sessionUser.id) {
        action(buttons, 'Add', function () { job(this, function () { return changeFriend(friend, 'request'); }); });
      }
      if (friend.id !== sessionUser.id) {
        action(buttons, 'Garage', function () {
          job(this, function () {
            return api.rest('motr_garages?owner=eq.' + encodeURIComponent(friend.id) + '&select=make,model,year,name,description').then(function (rows) {
              var bike = rows && rows[0];
              var existing = row.querySelector('.friend-bike');
              if (existing) existing.parentNode.removeChild(existing);
              child(row, 'small', bike ? [bike.name, [bike.make, bike.model, bike.year].filter(Boolean).join(' '), bike.description].filter(Boolean).join(' · ') : 'No public motorcycle.', 'friend-bike muted');
            });
          });
        });
      }
    });
  }
  function changeFriend(friend, state) {
    return api.rpc('motr_friend_action', { target: friend.id, action: state }).then(loadProfile);
  }
  function loadProfile() {
    var user = sessionUser;
    if (!user) return Promise.resolve();
    return Promise.all([api.rpc('motr_rider_handle'), api.rpc('motr_friend_list'), api.rpc('motr_friend_requests'), api.rpc('motr_friend_card')])
      .then(function (results) {
        if (user !== sessionUser) return;
        var handle = results[0];
        set('rider-name', handle ? '@' + handle : 'Your rider profile');
        if (document.activeElement !== el('rider-handle')) el('rider-handle').value = handle || '';
        el('friend-private').checked = !(results[3] && results[3][0] && results[3][0].is_private === false);
        renderFriends((results[2] || []).concat(results[1] || []), 'Find someone by their MOTR username.');
      });
  }
  submit('handle-form', function () {
    return api.rpc('motr_set_rider_handle', { username: value('rider-handle') }).then(function () { explain('Username saved.'); return loadProfile(); });
  });
  submit('friend-search', function () {
    return api.rpc('motr_find_rider', { username: value('friend-handle') }).then(function (friends) {
      if (sessionUser) renderFriends(friends || [], 'No rider found with that username.');
    });
  });
  el('friend-private').addEventListener('change', function () {
    var input = this;
    var requested = input.checked;
    job(input, function () {
      return api.rpc('motr_set_friend_privacy', { make_private: requested }).catch(function (error) {
        input.checked = !requested;
        throw error;
      });
    });
  });
  function garageRoute() { return 'motr_garages?owner=eq.' + encodeURIComponent(sessionUser.id); }
  function garageStorage() { return 'motr-iphone-garage-' + sessionUser.id; }
  function loadGarage() {
    var user = sessionUser;
    if (!user) return Promise.resolve();
    return api.rest(garageRoute() + '&select=make,model,year,name,description').then(function (rows) {
      if (user !== sessionUser) return;
      var shared = rows && rows[0];
      var bike = shared || api.read(garageStorage(), {});
      ['name', 'make', 'model', 'year', 'bio'].forEach(function (field) {
        el('bike-' + field).value = bike[field === 'bio' ? 'description' : field] || '';
      });
      el('bike-public').checked = Boolean(shared);
    });
  }
  submit('garage-form', function () {
    if (!sessionUser) return;
    var bike = { owner: sessionUser.id, make: value('bike-make'), model: value('bike-model'),
      year: value('bike-year'), name: value('bike-name'), description: value('bike-bio') };
    if (!bike.make || !bike.model || (bike.year && !/^\d{4}$/.test(bike.year))) throw new Error('Enter a make, a model, and an optional 4-digit year.');
    if (bike.name.length > 40) throw new Error('Use 40 characters or fewer for your motorcycle name.');
    var key = garageStorage();
    var shared = el('bike-public').checked;
    var request = shared ? api.rest('motr_garages?on_conflict=owner', { method: 'POST', body: bike, prefer: 'resolution=merge-duplicates' }) :
      api.rest(garageRoute(), { method: 'DELETE' });
    return request.then(function () { api.write(key, bike); explain(shared ? 'Public garage updated.' : 'Motorcycle saved privately on this device.'); });
  });

  function setTheme() {
    var choice = el('theme').value;
    var light = choice === 'light' || (choice === 'system' && !themeMedia.matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    document.querySelector('meta[name=theme-color]').content = light ? '#f3f2ef' : '#121416';
  }
  function reflectNetwork() {
    set('connection', navigator.onLine ? 'Online' : 'Offline');
    el('connection').classList.toggle('offline', !navigator.onLine);
  }
  el('theme').value = api.read('motr-iphone-theme', 'system');
  el('theme').addEventListener('change', function () { api.write('motr-iphone-theme', this.value); setTheme(); });
  if (themeMedia.addListener) themeMedia.addListener(setTheme);
  var iOS = navigator.userAgent.match(/(?:iPhone|iPad|iPod).*?OS (\d+)_(\d+)/);
  var legacy = iOS && (Number(iOS[1]) < 18 || (Number(iOS[1]) === 18 && Number(iOS[2]) < 4));
  document.documentElement.classList.toggle('glass-ready', !legacy);
  el('motion').checked = api.read('motr-iphone-reduced-motion', false);
  document.documentElement.classList.toggle('reduce-motion', el('motion').checked);
  el('motion').addEventListener('change', function () {
    api.write('motr-iphone-reduced-motion', this.checked);
    document.documentElement.classList.toggle('reduce-motion', this.checked);
  });
  el('keep-awake').disabled = !tracking.supported() || Boolean(legacy);
  if (el('keep-awake').disabled) set('wake-help', 'Automatic screen wake needs a supported browser. Install through Safari on iOS 18.4 or newer.');
  else el('keep-awake').checked = api.read('motr-iphone-wake', false);
  el('keep-awake').addEventListener('change', function () { api.write('motr-iphone-wake', this.checked); tracking.awake(this.checked); });
  el('nearby').addEventListener('change', function () {
    if (this.checked && !sessionUser) { this.checked = false; navigate('profile'); explain('Sign in to use Nearby Discovery.'); return; }
    if (this.checked && !navigator.geolocation) { this.checked = false; explain('Location permission needs Safari and HTTPS.'); return; }
    tracking.nearby(this.checked);
  });
  click('toggle-gps', function () {
    if (!navigator.geolocation) throw new Error('Location permission needs Safari and HTTPS.');
    if (!currentTracking || !currentTracking.gps) firstFix = true;
    tracking.gps(!(currentTracking && currentTracking.gps));
  });
  click('center', function () {
    if (!map || !currentFix) throw new Error('Start GPS and wait for your location.');
    map.setView([currentFix.coords.latitude, currentFix.coords.longitude], Math.max(15, map.getZoom()), { animate: false });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (control) {
    control.addEventListener('click', function (event) { event.preventDefault(); navigate(control.dataset.view); });
  });
  window.addEventListener('hashchange', function () { showView(location.hash.slice(1)); });
  window.addEventListener('online', reflectNetwork);
  window.addEventListener('offline', function () { reflectNetwork(); markers(nearbyMarkers, [], '', false); markers(rideMarkers, [], '', false); });
  window.addEventListener('motr-session-expired', function () { tracking.clearSharing(); account(); navigate('profile'); explain('Your session expired. Sign in again.'); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) markers(rideMarkers, [], '', false);
    else { refreshRide(); readMessages(); }
  });
  window.setInterval(function () { refreshRide(); readMessages(); }, 4300);
  try { linkedInvite = new URLSearchParams(location.search).get('join'); } catch (_) { linkedInvite = null; }
  if (linkedInvite) {
    try { linkedInvite = extractInvite(linkedInvite); } catch (_) { linkedInvite = null; }
    if (linkedInvite) history.replaceState(null, '', location.pathname + location.hash);
  }
  setTheme();
  reflectNetwork();
  renderHistory();
  tracking.init(trackState, function (cells) {
    markers(nearbyMarkers, cells.map(function (cell) { return [cell[1] / 400, cell[0] / 400]; }), '#e8a44e', true);
  });
  tracking.awake(el('keep-awake').checked);
  showView(location.hash.slice(1));
  account();
  if (linkedInvite && !sessionUser) navigate('profile');
  if (api.current()) api.ensure().then(account).catch(function () {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(function () {});
}());
