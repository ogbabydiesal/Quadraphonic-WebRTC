
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
  remoteStream.addTrack(event.track);
  if (peerAudioConnected) return;

  const remoteAudioTracks = event.streams[0] ? event.streams[0].getAudioTracks() : [];
  if (remoteAudioTracks.length < 4) return; // wait for the rest of the channels
  peerAudioConnected = true;

  let merger = audioContext.createChannelMerger(4);
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


// same room every session, so there's no new code to share each time
const FIXED_ROOM_ID = '123distantstreams22123';

async function clearCandidates(roomRef) {
  for (const name of ['callerCandidates', 'calleeCandidates']) {
    const candidates = await roomRef.collection(name).get();
    await Promise.all(candidates.docs.map(candidate => candidate.ref.delete()));
  }
}

async function createRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;
  const db = firebase.firestore();
  const roomRef = db.collection('rooms').doc(FIXED_ROOM_ID);

  // the room is reused, so clear ICE candidates left over from an earlier session
  await clearCandidates(roomRef);

  //console.log('Create PeerConnection with configuration: ', configuration);
  peerConnection = new RTCPeerConnection(configuration);

  registerPeerConnectionListeners();

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  // Code for collecting ICE candidates below
  const callerCandidatesCollection = roomRef.collection('callerCandidates');

  peerConnection.addEventListener('icecandidate', event => {
    if (!event.candidate) {
      //console.log('Got final candidate!');
      return;
    }
    //console.log('Got candidate: ', event.candidate);
    callerCandidatesCollection.add(event.candidate.toJSON());
  });
  // Code for collecting ICE candidates above

  // Code for creating a room below
  const offer = await peerConnection.createOffer();
  
  //MUNGE THE SDP
  offer.sdp = mungeSDP(offer.sdp);
  
  await peerConnection.setLocalDescription(offer);
  //console.log("SDP Offer:\n", peerConnection.localDescription.sdp);
  //console.log('Created offer:', offer);

  const roomWithOffer = { 
    'offer': {
      type: offer.type,
      sdp: offer.sdp,
    },
  };
  await roomRef.set(roomWithOffer);
  //console.log('roomWithOffer:' + roomWithOffer)
  roomId = roomRef.id;
  //console.log(`New room created with SDP offer. Room ID: ${roomRef.id}`);
  //write the roomRef to the UI
  
  document.querySelector(
      '#currentRoom').innerText = `Room ID: ${roomRef.id} - You are the caller!`;
  // Code for creating a room above

  peerConnection.addEventListener('track', handleRemoteTrack);

  // Listening for remote session description below
  roomRef.onSnapshot(async snapshot => {
    const data = snapshot.data();
    if (!peerConnection.currentRemoteDescription && data && data.answer) {
      //console.log('Got remote description: ', data.answer);
      const rtcSessionDescription = new RTCSessionDescription(data.answer);
      await peerConnection.setRemoteDescription(rtcSessionDescription);
    }
  });
  // Listening for remote session description above

  // Listen for remote ICE candidates below
  roomRef.collection('calleeCandidates').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      if (change.type === 'added') {
        let data = change.doc.data();
        //console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
        await peerConnection.addIceCandidate(new RTCIceCandidate(data));
      }
    });
  });
  // Listen for remote ICE candidates above
}

function joinRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;

  roomDialog.addEventListener('close', async () => {
    if (roomDialog.returnValue !== 'yes') return;
    roomId = document.querySelector('#room-id').value;
    document.querySelector(
        '#currentRoom').innerText = `Room ID: ${roomId} - You are the callee!`;
    await joinRoomById(roomId);
  }, {once: true});
  roomDialog.returnValue = '';
  roomDialog.showModal();
}

async function joinRoomById(roomId) {
  const db = firebase.firestore();
  const roomRef = db.collection('rooms').doc(`${roomId}`);
  const roomSnapshot = await roomRef.get();
  //console.log('Got room:', roomSnapshot.exists);

  if (roomSnapshot.exists) {
    //console.log('Create PeerConnection with configuration: ', configuration);
    peerConnection = new RTCPeerConnection(configuration);
    registerPeerConnectionListeners();
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // Code for collecting ICE candidates below
    const calleeCandidatesCollection = roomRef.collection('calleeCandidates');
    peerConnection.addEventListener('icecandidate', event => {
      if (!event.candidate) {
        //console.log('Got final candidate!');
        return;
      }
      //console.log('Got candidate: ', event.candidate);
      calleeCandidatesCollection.add(event.candidate.toJSON());
    });
    // Code for collecting ICE candidates above

    peerConnection.addEventListener('track', handleRemoteTrack);

    // Code for creating SDP answer below
    const offer = roomSnapshot.data().offer;
    //console.log('Got offer:', offer);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    //console.log("📥 Received offer SDP:\n", offer.sdp);
    const answer = await peerConnection.createAnswer();
    //console.log('Created answer:', answer);
    await peerConnection.setLocalDescription(answer);

    const roomWithAnswer = {
      answer: {
        type: answer.type,
        sdp: answer.sdp,
      },
    };

    await roomRef.update(roomWithAnswer);
    // Code for creating SDP answer above

    // Listening for remote ICE candidates below
    roomRef.collection('callerCandidates').onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type === 'added') {
          let data = change.doc.data();
          //console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
          
          await peerConnection.addIceCandidate(new RTCIceCandidate(data));
          //console.log("channel info here: " + peerConnection.localDescription.sdp);
        }
      });
    });
    // Listening for remote ICE candidates above
  }
}

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
  document.querySelector('#currentRoom').innerText = '';

  // Delete room on hangup
  if (roomId) {
    const db = firebase.firestore();
    const roomRef = db.collection('rooms').doc(roomId);
    const calleeCandidates = await roomRef.collection('calleeCandidates').get();
    calleeCandidates.forEach(async candidate => {
      await candidate.ref.delete();
    });
    const callerCandidates = await roomRef.collection('callerCandidates').get();
    callerCandidates.forEach(async candidate => {
      await candidate.ref.delete();
    });
    await roomRef.delete();
  }

  document.location.reload(true);
}

function registerPeerConnectionListeners() {
  peerConnection.addEventListener('icegatheringstatechange', () => {
    //console.log(`ICE gathering state changed: ${peerConnection.iceGatheringState}`);
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    //console.log(`Connection state change: ${peerConnection.connectionState}`);
  });

  peerConnection.addEventListener('signalingstatechange', () => {
    //console.log(`Signaling state change: ${peerConnection.signalingState}`);
  });

  peerConnection.addEventListener('iceconnectionstatechange ', () => {
    //console.log(`ICE connection state change: ${peerConnection.iceConnectionState}`);
  });
}

init();
