
import { handleTrackEvent } from './trackHandler.js';
let audioContext = null;
let channels = 2; // Default to stereo
let audioTracks = [];
let gains = [];

const configuration = {
  //  iceServers: [
  //   {
  //     urls: [
  //       'stun:stun1.l.google.com:19302',
  //       'stun:stun2.l.google.com:19302',
  //     ],
  //   },
  // ],
  iceServers: [{   urls: [ "stun:us-turn1.xirsys.com" ]}, {   username: "7H2qmpDLA7VVsPxy8WgM8EVdh5qLSdqsIeqISxYj2Ge8YtOorR0iMxSeJDtFYa9BAAAAAGjUsoVvZ2JhYnlkaWVzYWw=",   credential: "1dbc5ed8-99bd-11f0-9ed2-0242ac140004",   urls: [       "turn:us-turn1.xirsys.com:80?transport=udp",       "turn:us-turn1.xirsys.com:3478?transport=udp",       "turn:us-turn1.xirsys.com:80?transport=tcp",       "turn:us-turn1.xirsys.com:3478?transport=tcp",       "turns:us-turn1.xirsys.com:443?transport=tcp",       "turns:us-turn1.xirsys.com:5349?transport=tcp"   ]}],
  iceCandidatePoolSize: 10,
};

let peerConnection = null;
let localStream = null;
let remoteStream = null;
let roomDialog = null;
let roomId = null;

// quad mix of our input + the peer, played on the chosen output via an <audio> element
let quadOutput = null;
let outputElement = null;
// separate levels for our input monitor and the peer, both feeding quadOutput
let localGainNode = null;
let peerGainNode = null;
let peerAudioConnected = false;
let peerMerger = null; // the peer's 4 channels, rebuilt on every (re)connect

let inputDevice = null;
let outputDevice = ''; // '' = system default output
let inputDevice_Video = null;

let infoPanel = true;
//mouse click
document.querySelector('#info').addEventListener('click', () => {
  infoPanel = !infoPanel;
  document.querySelector('#infoContainer').style.display = infoPanel ? 'flex' : 'none';
});

function getAudioVideoInputDevices() {
  getAudioInputDevices();
  getVideoInputDevices();
}

function init() {
  document.querySelector('#inDeviceBtn').addEventListener('click', getAudioVideoInputDevices);
  document.getElementById('audioInputSelect').addEventListener('change', async (e) => {
    inputDevice = e.target.value;
    console.log('Selected input device:', inputDevice);
  });
  document.getElementById('audioOutputSelect').addEventListener('change', async (e) => {
    outputDevice = e.target.value;
    console.log('Selected output device:', outputDevice || 'system default');
    if (outputElement) await outputElement.setSinkId(outputDevice);
  });
  document.getElementById('localGainSlider').addEventListener('input', (e) => {
    setGain(localGainNode, sliderToGain(e.target.value));
  });
  document.getElementById('peerGainSlider').addEventListener('input', (e) => {
    setGain(peerGainNode, sliderToGain(e.target.value));
  });
  document.getElementById('videoInputSelect').addEventListener('change', async (e) => {
    inputDevice_Video = e.target.value;
    console.log('Selected video device:', inputDevice_Video);
  });

  document.getElementById('blendModeSelect').addEventListener('change', applyVideoOverlay);
  document.getElementById('topVideoSelect').addEventListener('change', applyVideoOverlay);

  document.querySelector('#cameraBtn').addEventListener('click', openUserMedia);
  document.querySelector('#hangupBtn').addEventListener('click', hangUp);
  document.querySelector('#createBtn').addEventListener('click', createRoom);
  document.querySelector('#joinBtn').addEventListener('click', joinRoom);
  document.querySelector('#copyRoomCodeBtn').addEventListener('click', copyRoomCode);
  roomDialog = document.querySelector('#room-dialog');
}

// the video last in #videos paints on top; it gets the .blend class and the
// chosen mix-blend-mode, and blends with the video underneath
function applyVideoOverlay() {
  const videos = document.getElementById('videos');
  const topVideo = document.getElementById(document.getElementById('topVideoSelect').value);
  videos.querySelectorAll('video').forEach(video => video.classList.remove('blend'));
  topVideo.classList.add('blend');
  videos.appendChild(topVideo);
  videos.style.setProperty('--video-blend-mode', document.getElementById('blendModeSelect').value);
}

// Gain sliders run 0-1 and rest at SAFE_POSITION, which gives SAFE_GAIN.
// Below that the gain falls linearly to 0; above it rises linearly to MAX_GAIN
const SAFE_POSITION = 0.75;
const SAFE_GAIN = 0.7;
const MAX_GAIN = 2.0; // +6 dB

function sliderToGain(position) {
  position = parseFloat(position);
  if (position <= SAFE_POSITION) return SAFE_GAIN * position / SAFE_POSITION;
  return SAFE_GAIN + (MAX_GAIN - SAFE_GAIN) * (position - SAFE_POSITION) / (1 - SAFE_POSITION);
}

function setGain(gainNode, value) {
  if (!gainNode) return; // sliders can move before the audio context exists
  gainNode.gain.setTargetAtTime(value, audioContext.currentTime, 0.02);
}

// 'track' fires once per remote track (1 video + 4 audio), so only add that
// event's track, and build the quad graph a single time once all 4 audio
// tracks are in the stream. Building it per event played the peer ~5x over.
function handleRemoteTrack(event) {
  if (event.target !== peerConnection) return; // from a replaced connection
  remoteStream.addTrack(event.track);
  if (peerAudioConnected) return;

  const remoteAudioTracks = event.streams[0] ? event.streams[0].getAudioTracks() : [];
  if (remoteAudioTracks.length < 4) return; // wait for the rest of the channels
  peerAudioConnected = true;

  const merger = audioContext.createChannelMerger(4);
  peerMerger = merger;
  merger.channelCountMode = 'explicit';
  merger.channelInterpretation = 'speakers';
  audioTracks = [];

  remoteAudioTracks.forEach(track => {
    //map the audio track to web audio api
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    audioTracks.push(source);
  });
  for (let i = 0; i < 4; i++) {
    const gainNode = audioContext.createGain();
    gains.push(gainNode.gain);
    audioTracks[i].connect(gainNode);
    gainNode.connect(merger, 0, i);
  }
  merger.connect(peerGainNode);
  audioContext.resume();

  console.log('Peer audio tracks:', remoteAudioTracks.length,
      remoteAudioTracks.map(track => track.getSettings().channelCount ?? '?').join(','), 'ch each');
  console.log('Output device:', outputElement.sinkId || 'system default');
  logChannelLevels('Peer level per channel', merger, 4);
}

// a reconnect brings new tracks: drop the old peer audio graph and video
function resetRemoteMedia() {
  if (peerMerger) peerMerger.disconnect();
  audioTracks.forEach(source => source.disconnect());
  peerMerger = null;
  audioTracks = [];
  gains = [];
  peerAudioConnected = false;
  if (remoteStream) remoteStream.getTracks().forEach(track => track.stop());
  remoteStream = new MediaStream();
  const remoteVideoEl = document.querySelector('#remoteVideo');
  if (remoteVideoEl.srcObject) remoteVideoEl.srcObject = remoteStream;
}

// prints the peak of each channel of `node` every 2s for 20s, to see which
// channels actually carry sound (all 0 = silent)
function logChannelLevels(label, node, channelCount) {
  const splitter = audioContext.createChannelSplitter(channelCount);
  node.connect(splitter);
  const analysers = [];
  for (let i = 0; i < channelCount; i++) {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    splitter.connect(analyser, i);
    analysers.push(analyser);
  }
  const buffer = new Float32Array(2048);
  let runs = 0;
  const timer = setInterval(() => {
    const peaks = analysers.map(analyser => {
      analyser.getFloatTimeDomainData(buffer);
      return buffer.reduce((max, v) => Math.max(max, Math.abs(v)), 0).toFixed(3);
    });
    console.log(label + ':', peaks.map((p, i) => `ch${i + 1} ${p}`).join('  '));
    if (++runs >= 10) clearInterval(timer);
  }, 2000);
}

function mungeSDP(sdp) {
  // Force stereo in Opus (common for multichannel needs)
   sdp = sdp.replace(/a=fmtp:111 minptime=10;useinbandfec=1/g,
                      'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1');

  //sdp = sdp.replace("opus/48000/2","multiopus/48000/4").replace("useinbandfec=1", "channel_mapping=0,1,2,3; num_streams=4; coupled_streams=0;maxaveragebitrate=510000;minptime=10;useinbandfec=1");


  // You could also try forcing the number of channels (not always honored)
   //sdp = sdp.replace(/a=rtpmap:111 opus\/48000\/2/g, 'a=rtpmap:111 multiopus/48000/4');

  // If you want to inspect what codecs are negotiated:
  // console.log(sdp);

  return sdp;
}


// Short room codes so they're easy to read out and type. Lowercase only, and
// no look-alikes (0/o, 1/l/i). Retry if the code is already taken.
const ROOM_CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const ROOM_CODE_LENGTH = 4;

function randomRoomCode() {
  const values = crypto.getRandomValues(new Uint32Array(ROOM_CODE_LENGTH));
  return Array.from(values, v => ROOM_CODE_CHARS[v % ROOM_CODE_CHARS.length]).join('');
}

async function newRoomRef(db) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const roomRef = db.collection('rooms').doc(randomRoomCode());
    if (!(await roomRef.get()).exists) return roomRef;
  }
  throw new Error('Could not find a free room code');
}

// --- Rejoining -------------------------------------------------------------
// A room lives as long as the caller keeps it open. Each connection attempt is
// a numbered "session": the caller writes { offer, session } to the room, the
// callee answers with { answer: {..., session} }, and every ICE candidate is
// tagged with its session so leftovers from an earlier attempt are ignored.
// When the connection drops, or the callee leaves or comes back, the caller
// starts the next session on the same code and the callee answers it.
let role = null; // 'caller' | 'callee'
let session = 0;
let currentRoomRef = null;
let remoteCandidates = []; // { id, session, init } from the other side
const appliedCandidates = new Set();
let restartingSession = false;
let disconnectTimer = null;
const DISCONNECT_GRACE_MS = 5000; // a 'disconnected' link often recovers by itself

function setStatus(message) {
  const who = role === 'caller' ? 'You are the caller, send this code to a friend and have them "Join Room"' : 'You are the callee';
  document.querySelector('#roomCode').textContent = roomId;
  document.querySelector('#roomCodeRow').hidden = !roomId;
  document.querySelector('#roomStatus').textContent = `${who} · ${message}`;
}

async function copyRoomCode() {
  const button = document.querySelector('#copyRoomCodeBtn');
  try {
    await navigator.clipboard.writeText(roomId);
    button.textContent = 'copied!';
  } catch (error) {
    // clipboard blocked: select the code so it can be copied by hand
    console.warn('Could not copy room code:', error);
    getSelection().selectAllChildren(document.querySelector('#roomCode'));
    button.textContent = 'press ⌘/ctrl+C';
  }
  clearTimeout(copyRoomCode.timer);
  copyRoomCode.timer = setTimeout(() => { button.textContent = 'copy'; }, 1500);
}

function listenForRemoteCandidates(collection) {
  collection.onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const { session: candidateSession, ...init } = change.doc.data();
      remoteCandidates.push({ id: change.doc.id, session: candidateSession, init });
    });
    applyRemoteCandidates();
  });
}

// candidates can arrive before the matching offer/answer, so they wait here
// until the current connection has its remote description
function applyRemoteCandidates() {
  const pc = peerConnection;
  if (!pc || !pc.remoteDescription) return;
  remoteCandidates
      .filter(c => c.session === session && !appliedCandidates.has(c.id))
      .forEach(c => {
        appliedCandidates.add(c.id);
        pc.addIceCandidate(new RTCIceCandidate(c.init))
            .catch(error => console.warn('Could not add ICE candidate:', error));
      });
}

function newPeerConnection(ownCandidates) {
  closePeerConnection();
  const thisSession = session;
  const pc = new RTCPeerConnection(configuration);
  peerConnection = pc;
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  pc.addEventListener('icecandidate', event => {
    if (!event.candidate) return;
    ownCandidates.add({ ...event.candidate.toJSON(), session: thisSession })
        .catch(error => console.warn('Could not send ICE candidate:', error));
  });
  pc.addEventListener('track', handleRemoteTrack);
  pc.addEventListener('connectionstatechange', () => onConnectionStateChange(pc));
  return pc;
}

function closePeerConnection() {
  clearTimeout(disconnectTimer);
  if (peerConnection) peerConnection.close();
  peerConnection = null;
  resetRemoteMedia();
}

function onConnectionStateChange(pc) {
  if (pc !== peerConnection) return; // an earlier, replaced connection
  const state = pc.connectionState;
  console.log(`Session ${session} connection: ${state}`);
  clearTimeout(disconnectTimer);

  if (state === 'connected') setStatus('connected');
  if (role === 'callee') {
    if (state === 'disconnected' || state === 'failed') setStatus('connection lost, waiting for the caller to reconnect…');
    return;
  }
  if (state === 'failed') {
    restartCallerSession('connection failed');
  } else if (state === 'disconnected') {
    setStatus('connection dropped, trying to recover…');
    disconnectTimer = setTimeout(() => {
      if (pc === peerConnection && pc.connectionState !== 'connected') {
        restartCallerSession('connection dropped');
      }
    }, DISCONNECT_GRACE_MS);
  }
}

async function deleteCandidates(roomRef) {
  for (const name of ['callerCandidates', 'calleeCandidates']) {
    const candidates = await roomRef.collection(name).get();
    await Promise.all(candidates.docs.map(candidate => candidate.ref.delete()));
  }
}

async function createRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;
  const db = firebase.firestore();
  const roomRef = await newRoomRef(db);
  role = 'caller';
  roomId = roomRef.id;
  currentRoomRef = roomRef;

  // these listeners stay for the life of the room; each session filters by number
  roomRef.onSnapshot(onCallerRoomSnapshot);
  listenForRemoteCandidates(roomRef.collection('calleeCandidates'));
  await startCallerSession();
}

async function startCallerSession() {
  const roomRef = currentRoomRef;
  await deleteCandidates(roomRef); // left over from the previous session
  session += 1;
  const thisSession = session;
  remoteCandidates = [];

  const pc = newPeerConnection(roomRef.collection('callerCandidates'));
  const offer = await pc.createOffer();
  offer.sdp = mungeSDP(offer.sdp);
  await pc.setLocalDescription(offer);
  if (thisSession !== session) return; // superseded while we were waiting

  // set() replaces the whole room, dropping the previous answer
  await roomRef.set({ offer: { type: offer.type, sdp: offer.sdp }, session: thisSession });
  setStatus(thisSession === 1 ? 'waiting for peer…' : 'waiting for peer to rejoin…');
}

async function restartCallerSession(reason) {
  if (role !== 'caller' || restartingSession || !currentRoomRef) return;
  restartingSession = true;
  console.log(`Restarting session after: ${reason}`);
  try {
    await startCallerSession();
  } catch (error) {
    console.error('Could not restart session:', error);
  } finally {
    restartingSession = false;
  }
}

async function onCallerRoomSnapshot(snapshot) {
  const data = snapshot.data();
  if (!data || data.session !== session) return;

  // the callee hung up, or reopened the page and wants a fresh offer
  if (data.calleeLeft === session) {
    restartCallerSession('peer left');
    return;
  }

  const pc = peerConnection;
  if (data.answer && data.answer.session === session &&
      pc && pc.signalingState === 'have-local-offer') {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: data.answer.type, sdp: data.answer.sdp }));
    applyRemoteCandidates();
    setStatus('peer joined, connecting…');
  }
}

function joinRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;

  roomDialog.addEventListener('close', async () => {
    if (roomDialog.returnValue !== 'yes') return;
    await joinRoomById(document.querySelector('#room-id').value.trim().toLowerCase());
  }, {once: true});
  roomDialog.returnValue = '';
  roomDialog.showModal();
}

async function joinRoomById(id) {
  const db = firebase.firestore();
  const roomRef = db.collection('rooms').doc(id);
  const roomSnapshot = await roomRef.get();

  if (!roomSnapshot.exists || !roomSnapshot.data().session) {
    document.querySelector('#roomStatus').textContent = `No room with code ${id}`;
    document.querySelector('#createBtn').disabled = false;
    document.querySelector('#joinBtn').disabled = false;
    return;
  }

  role = 'callee';
  roomId = id;
  currentRoomRef = roomRef;
  setStatus('joining…');

  // the current offer was already answered (most likely by us before a reload
  // or a dropped connection), so ask the caller for a fresh one
  const data = roomSnapshot.data();
  if (data.answer && data.answer.session === data.session) {
    await roomRef.update({ calleeLeft: data.session });
  }

  listenForRemoteCandidates(roomRef.collection('callerCandidates'));
  roomRef.onSnapshot(onCalleeRoomSnapshot);
}

async function onCalleeRoomSnapshot(snapshot) {
  if (!snapshot.exists) {
    closePeerConnection();
    setStatus('the caller closed the room');
    return;
  }
  const data = snapshot.data();
  if (!data.offer || !(data.session > session)) return; // nothing new
  if (data.answer && data.answer.session === data.session) return; // already answered
  if (data.calleeLeft === data.session) return; // a fresh offer is on its way

  // a new session from the caller: answer it on a fresh connection
  session = data.session;
  const thisSession = session;
  remoteCandidates = remoteCandidates.filter(c => c.session >= thisSession);
  const pc = newPeerConnection(currentRoomRef.collection('calleeCandidates'));

  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  applyRemoteCandidates();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  if (thisSession !== session) return;

  await currentRoomRef.update({ answer: { type: answer.type, sdp: answer.sdp, session: thisSession } });
  setStatus('connecting…');
}

// best effort when the callee closes or reloads the tab; if this write doesn't
// make it out, rejoining with the code still asks the caller for a fresh offer
window.addEventListener('pagehide', () => {
  if (role === 'callee' && currentRoomRef && session) {
    currentRoomRef.update({ calleeLeft: session }).catch(() => {});
  }
});

async function openUserMedia() {
  //debug the input device name
  if (inputDevice) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const selectedDevice = devices.find(device => device.deviceId === inputDevice);
    console.log('Selected input device name:', selectedDevice ? selectedDevice.label : 'Unknown device');
  }
  //use device 4 as the microphone input
  const stream = await navigator.mediaDevices.getUserMedia(
      {
        video: {
          deviceId: inputDevice_Video ? { exact: inputDevice_Video } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        },
        audio: {
          deviceId: inputDevice ? { exact: inputDevice } : undefined,
          channelCount: { ideal: 4 }, // falls back to 2 without a 4 channel device
          sampleRate: 48000,
          sampleSize: 16,
          echoCancellation: false, //wierdly 
          noiseSuppression: false,
          autoGainControl: false,
      }});
  const inputSettings = stream.getAudioTracks()[0].getSettings();
  console.log('Input channel count:', inputSettings.channelCount ?? 2, '@', inputSettings.sampleRate ?? 'default rate');

  // Step 2: Create Web Audio context
  audioContext = new AudioContext();

  // // Step 3: Use the input stream as a source node
  const source = audioContext.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));

  // one WebRTC track per input channel; with a stereo device channels 3 and 4
  // are silent, so the peer always gets 4 tracks
  const micSplitter = audioContext.createChannelSplitter(4);
  source.connect(micSplitter);

  // 🔊 Quad output: nothing goes to audioContext.destination. Our input and the
  // peer (connected on 'track') are mixed into a 4 channel stream and played by
  // an <audio> element on the chosen output, channel N -> output N
  quadOutput = audioContext.createMediaStreamDestination();
  quadOutput.channelCount = 4;
  quadOutput.channelCountMode = 'explicit';
  quadOutput.channelInterpretation = 'discrete';
  localGainNode = audioContext.createGain();
  localGainNode.channelInterpretation = 'discrete';
  localGainNode.gain.value = sliderToGain(document.getElementById('localGainSlider').value);
  localGainNode.connect(quadOutput);
  source.connect(localGainNode);
  peerGainNode = audioContext.createGain();
  peerGainNode.channelInterpretation = 'discrete';
  peerGainNode.gain.value = sliderToGain(document.getElementById('peerGainSlider').value);
  peerGainNode.connect(quadOutput);

  outputElement = new Audio();
  outputElement.srcObject = quadOutput.stream;
  if (outputDevice) await outputElement.setSinkId(outputDevice);
  
  //start the microphone input
  await audioContext.resume();
  await outputElement.play();
  logChannelLevels('Input level per channel (sent to peer)', source, 4);
  
  // 🎥 Merge with video
  const combinedStream = new MediaStream();

  //add the video and audio tracks to the combined stream -> out
  stream.getVideoTracks().forEach(track => combinedStream.addTrack(track));
  for (let i = 0; i < 4; i++) {
    // 🎯 Send to WebRTC
    const channelNode = audioContext.createGain({channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers'});
    const RTCdestination = audioContext.createMediaStreamDestination( { channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speaker' });
    micSplitter.connect(channelNode, i);
    channelNode.connect(RTCdestination);
    RTCdestination.stream.getAudioTracks().forEach(track => combinedStream.addTrack(track));
  }
  combinedStream.getTracks().forEach(track => {
    //.log(`Track ${track.kind} settings:`, track.getSettings());
    //console.log(`Track ${track.kind} constraints:`, track.getConstraints());
  });

  document.querySelector('#localVideo').srcObject = stream;
  document.querySelector('#localVideo').style.display = 'block';
  localStream = combinedStream; //might just need to be RTCdestination

  // Create a remote stream to receive the remote video and audio, ensuring it is stereo
  remoteStream = new MediaStream();

  const remoteVideoEl = document.querySelector('#remoteVideo');
  remoteVideoEl.srcObject = remoteStream;
  remoteVideoEl.style.display = 'block';
  remoteVideoEl.muted = true; // simplest
  remoteVideoEl.volume = 0; 

  document.querySelector('#cameraBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = false;
  document.querySelector('#createBtn').disabled = false;
  document.querySelector('#hangupBtn').disabled = false;
}

async function getAudioInputDevices() {
  await  navigator.mediaDevices.getUserMedia({ audio: true });
  navigator.mediaDevices.enumerateDevices()
    .then(devices => {
      const audioInputDevices = devices.filter(device => device.kind === 'audioinput');
      const audioInputSelect = document.getElementById('audioInputSelect');
      audioInputSelect.innerHTML = '';
      audioInputSelect.appendChild(new Option('choose input', ''));
      audioInputDevices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${audioInputDevices.indexOf(device) + 1}`;
        audioInputSelect.appendChild(option);
      });

      const audioOutputSelect = document.getElementById('audioOutputSelect');
      audioOutputSelect.innerHTML = '';
      audioOutputSelect.appendChild(new Option('choose output', ''));
      devices.filter(device => device.kind === 'audiooutput').forEach(device => {
        audioOutputSelect.appendChild(new Option(device.label || device.deviceId, device.deviceId));
      });
      audioOutputSelect.value = outputDevice;
    })
    .catch(error => {
      console.error('Error getting audio input devices:', error);
    });
}

async function getVideoInputDevices() {
  await  navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  navigator.mediaDevices.enumerateDevices()
    .then(devices => {
      const videoInputDevices = devices.filter(device => device.kind === 'videoinput');
      const videoInputSelect = document.getElementById('videoInputSelect');
      videoInputSelect.innerHTML = '';
      videoInputDevices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${videoInputDevices.indexOf(device) + 1}`;
        videoInputSelect.appendChild(option);
      });
    })
    .catch(error => {
      console.error('Error getting video input devices:', error);
    });
}

// function toggleAudioChannel(channelIndex) {
//   return function() {
//     const checkbox = document.querySelector(`#audioCheckboxCh_${channelIndex + 1}`);
//     if (checkbox.checked) {
//       audioTracks[channelIndex].gain.value = 1; // Enable channel
//       console.log(`Channel ${channelIndex + 1} enabled`);
//     } else {
//       audioTracks[channelIndex].gain.value = 0; // Disable channel
//       console.log(`Channel ${channelIndex + 1} disabled`);
//     }
//   };
// }

async function hangUp(e) {
  const tracks = document.querySelector('#localVideo').srcObject.getTracks();
  tracks.forEach(track => {
    track.stop();
  });

  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
  }

  if (peerConnection) {
    peerConnection.close();
  }

  document.querySelector('#localVideo').srcObject = null;
  document.querySelector('#remoteVideo').srcObject = null;
  document.querySelector('#cameraBtn').disabled = false;
  document.querySelector('#joinBtn').disabled = true;
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#hangupBtn').disabled = true;
  document.querySelector('#roomCodeRow').hidden = true;
  document.querySelector('#roomStatus').textContent = '';

  // The caller owns the room, so it deletes it. The callee only marks that it
  // left, so the caller re-offers and the callee (or someone else) can rejoin.
  if (currentRoomRef) {
    try {
      if (role === 'caller') {
        await deleteCandidates(currentRoomRef);
        await currentRoomRef.delete();
      } else if (role === 'callee' && session) {
        await currentRoomRef.update({ calleeLeft: session });
      }
    } catch (error) {
      console.warn('Could not clean up room:', error);
    }
  }

  document.location.reload(true);
}

init();
