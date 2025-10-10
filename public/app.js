
import { handleTrackEvent } from './trackHandler.js';
let audioContext = null;
let channels = 2; // Default to stereo
let audioTracks = [];
let gains = [];
mdc.ripple.MDCRipple.attachTo(document.querySelector('.mdc-button'));

const configuration = {
   iceServers: [
    {
      urls: [
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
  ],
  iceCandidatePoolSize: 10,
};

let peerConnection = null;
let localStream = null;
let remoteStream = null;
let roomDialog = null;
let roomId = null;

let inputDevice = null;
let inputDevice2 = null;
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
  document.getElementById('audioInputSelect2').addEventListener('change', async (e) => {
    inputDevice2 = e.target.value;
    console.log('Selected input device 2:', inputDevice2);

  });
  document.getElementById('videoInputSelect').addEventListener('change', async (e) => {
    inputDevice_Video = e.target.value;
    console.log('Selected video device:', inputDevice_Video);
  });

  document.querySelector('#cameraBtn').addEventListener('click', openUserMedia);
  document.querySelector('#hangupBtn').addEventListener('click', hangUp);
  document.querySelector('#createBtn').addEventListener('click', createRoom);
  document.querySelector('#joinBtn').addEventListener('click', joinRoom);
  roomDialog = new mdc.dialog.MDCDialog(document.querySelector('#room-dialog'));
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


async function createRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;
  const db = firebase.firestore();
  const roomRef = await db.collection('rooms').doc();
  
  //comment this line out and remove fixedRoomId above when you want to use a secret pass
  //roomId = fixedRoomId;
  
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

  peerConnection.addEventListener('track', event => {
      //console.log('Got remote track:', event.streams[0]);
      let merger = audioContext.createChannelMerger(4);
      merger.channelCountMode = 'explicit';
      merger.channelInterpretation = 'speakers';
      audioTracks = [];
      
      event.streams[0].getTracks().forEach(track => {
        //console.log('Add a track to the remoteStream:', track);
        remoteStream.addTrack(track);
        //separate audio tracks from the remote stream
        if (track.kind === 'audio') {
          const splitter = audioContext.createChannelSplitter(2);
          let newStream = new MediaStream([track]);
          //map the audio track to web audio api //changed from createMediaStreamSource
          const source = audioContext.createMediaStreamSource(newStream);
          audioTracks.push(source);
        }
      });
      // console.log('here are the audioTracks:' + audioTracks);
      // console.log(audioTracks.length + ' audio tracks connected');
      for (let i = 0; i < 4; i++) {
        const gainNode = audioContext.createGain();
        gains.push(gainNode.gain);
        audioTracks[i].connect(gainNode);
        gainNode.connect(merger, 0, i);
        //audioTracks[i].connect(merger, 0, i);
        //console.log('connected audio track to merger');
      }
      
      merger.connect(audioContext.destination);
      audioContext.resume();
  });

  const gainSlider = document.createElement('input');
  gainSlider.type = 'range';
  gainSlider.min = '0';
  gainSlider.max = '1.2';
  gainSlider.step = '0.01';
  gainSlider.value = '0.8';
  gainSlider.id = 'gainSlider';

  const gainLabel = document.createElement('label');
  gainLabel.htmlFor = 'gainSlider';
  gainLabel.textContent = 'Peer Gain: ';

  document.querySelector('#buttons').appendChild(gainLabel);
  document.querySelector('#buttons').appendChild(gainSlider);

  gainSlider.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    gains.forEach(gainParam => {
      gainParam.value = value;
    });
  });

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

  document.querySelector('#confirmJoinBtn').
      addEventListener('click', async () => {
        //console.log('Join room button clicked');
        roomId = document.querySelector('#room-id').value;
        //console.log('Join room: ', roomId);
        document.querySelector(
            '#currentRoom').innerText = `Room ID: ${roomId} - You are the callee!`;
        await joinRoomById(roomId);
      }, {once: true});
  roomDialog.open();
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

    peerConnection.addEventListener('track', event => {
      //console.log('Got remote track:', event.streams[0]);
      let merger = audioContext.createChannelMerger(4);
      merger.channelCountMode = 'explicit';
      merger.channelInterpretation = 'speakers';
      audioTracks = [];
      
      event.streams[0].getTracks().forEach(track => {
        //console.log('Add a track to the remoteStream:', track);
        remoteStream.addTrack(track);
        //separate audio tracks from the remote stream
        if (track.kind === 'audio') {
          const splitter = audioContext.createChannelSplitter(2);
          let newStream = new MediaStream([track]);
          //map the audio track to web audio api //changed from createMediaStreamSource
          const source = audioContext.createMediaStreamSource(newStream);
          audioTracks.push(source);
        }
        
      });
      // console.log('here are the audioTracks:' + audioTracks);
      // console.log(audioTracks.length + ' audio tracks connected');
      for (let i = 0; i < 4; i++) {
        const gainNode = audioContext.createGain();
        gains.push(gainNode.gain);
        audioTracks[i].connect(gainNode);
        gainNode.connect(merger, 0, i);
      }
      merger.connect(audioContext.destination);
      audioContext.resume();
    });

    const gainSlider = document.createElement('input');
    gainSlider.type = 'range';
    gainSlider.min = '0';
    gainSlider.max = '1.2';
    gainSlider.step = '0.01';
    gainSlider.value = '0.8';
    gainSlider.id = 'gainSlider';

    const gainLabel = document.createElement('label');
    gainLabel.htmlFor = 'gainSlider';
    gainLabel.textContent = 'Peer Gain: ';

    document.querySelector('#buttons').appendChild(gainLabel);
    document.querySelector('#buttons').appendChild(gainSlider);


    gainSlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      gains.forEach(gainParam => {
        gainParam.value = value;
      });
    });

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
          channelCount: 2,
          sampleRate: 48000,
          sampleSize: 16,
          echoCancellation: false, //wierdly 
          noiseSuppression: false,
          autoGainControl: false,
      }});
  const stream2 = await navigator.mediaDevices.getUserMedia(
    {
      video: false,
      audio: {
        deviceId: inputDevice2 ? { exact: inputDevice2 } : undefined,
        channelCount: 2,
        sampleRate: 48000,
        sampleSize: 16,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }});

  // Step 2: Create Web Audio context
  audioContext = new AudioContext();
  let maxChannelCount = audioContext.destination.maxChannelCount;
  audioContext.destination.channelCount = maxChannelCount;
  
  // 🎯 Send to WebRTC
  const RTCdestination = audioContext.createMediaStreamDestination( { channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speaker' });
  const RTCdestination2 = audioContext.createMediaStreamDestination( { channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speaker' });
  const RTCdestination3 = audioContext.createMediaStreamDestination( { channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speaker' });
  const RTCdestination4 = audioContext.createMediaStreamDestination( { channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speaker' });

  // // Step 3: Use the input stream as a source node  
  const audioOnlyStream = new MediaStream(stream.getAudioTracks());
  audioOnlyStream.channelCount = channels;
  audioOnlyStream.channelCountMode = 'explicit';
  audioOnlyStream.channelInterpretation = 'discrete';

  const source = audioContext.createMediaStreamSource(audioOnlyStream);
  source.channelCount = channels; // Set to stereo
  source.channelCountMode = 'explicit';
  source.channelInterpretation = 'discrete';

  const micSplitter = audioContext.createChannelSplitter(channels);
  source.connect(micSplitter);
  const leftNode = audioContext.createGain({channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers'});
  const rightNode = audioContext.createGain({channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers'});
  micSplitter.connect(leftNode, 0);
  micSplitter.connect(rightNode, 1);

  leftNode.connect(RTCdestination);
  rightNode.connect(RTCdestination2);

  const audioOnlyStream2 = new MediaStream(stream2.getAudioTracks());
  audioOnlyStream2.channelCount = channels;
  audioOnlyStream2.channelCountMode = 'explicit';
  audioOnlyStream2.channelInterpretation = 'discrete';
  const source2 = audioContext.createMediaStreamSource(audioOnlyStream2);
  source2.channelCount = channels; // Set to stereo
  source2.channelCountMode = 'explicit';
  const micSplitter2 = audioContext.createChannelSplitter(channels);
  source2.connect(micSplitter2);
  const leftNode2 = audioContext.createGain({channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers'});
  const rightNode2 = audioContext.createGain({channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers'});
  micSplitter2.connect(leftNode2, 0);
  micSplitter2.connect(rightNode2, 1);

  leftNode2.connect(RTCdestination3);
  rightNode2.connect(RTCdestination4);

  //uncomment below line to hear the merged audio locally
  //source.connect(audioContext.destination);
  
  //start the microphone input
  await audioContext.resume();
  
  // 🎥 Merge with video
  const combinedStream = new MediaStream();

  //add the video and audio tracks to the combined stream -> out
  stream.getVideoTracks().forEach(track => combinedStream.addTrack(track));
  RTCdestination.stream.getAudioTracks().forEach(track => combinedStream.addTrack(track));
  RTCdestination2.stream.getAudioTracks().forEach(track => combinedStream.addTrack(track));
  RTCdestination3.stream.getAudioTracks().forEach(track => combinedStream.addTrack(track));
  RTCdestination4.stream.getAudioTracks().forEach(track => combinedStream.addTrack(track));
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
      const audioInputSelect2 = document.getElementById('audioInputSelect2');
      audioInputSelect.innerHTML = '';
      audioInputSelect2.innerHTML = '';
      audioInputDevices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${audioInputDevices.indexOf(device) + 1}`;
        audioInputSelect.appendChild(option);
        audioInputSelect2.appendChild(option.cloneNode(true));
      });
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