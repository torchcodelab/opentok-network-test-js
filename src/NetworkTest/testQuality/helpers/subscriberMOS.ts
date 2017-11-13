import isBitrateSteadyState from './isBitrateSteadyState';
import calculateThroughput from './calculateThroughput';
import { getOr, last, nth } from '../../../util';
import { currentId } from 'async_hooks';


// const calculatePacketLoss = (stats: OT.TrackStats): number => {

// }

const getPacketsLost = (ts: OT.TrackStats): number => getOr(0, 'packetsLost', ts);
const getPacketsReceived = (ts: OT.TrackStats): number => getOr(0, 'packetsReceived', ts);
const getTotalPackets = (ts: OT.TrackStats): number => getPacketsLost(ts) + getPacketsReceived(ts);

const calculateTotalPackets = (type: 'audio' | 'video', current: OT.SubscriberStats, last: OT.SubscriberStats) =>
  getTotalPackets(current[type]) - getTotalPackets(last[type]);

const calculateBitRate = (type: 'audio' | 'video', current: OT.SubscriberStats, last: OT.SubscriberStats): number => {
  const interval = current.timestamp - last.timestamp;
  return (8 * (current[type].bytesReceived - last[type].bytesReceived)) / (interval / 1000);
};

const calculateVideoScore = (subscriber: OT.Subscriber, stats: OT.SubscriberStats[]): number => {
  const targetBitrateForPixelCount = (pixelCount: number) => {
    // power function maps resolution to target bitrate, based on rumor config
    // values, with r^2 = 0.98. We're ignoring frame rate, assume 30.
    const y = 2.069924867 * (Math.log10(pixelCount) ** 0.6250223771);
    return 10 ** y;
  };

  const MIN_VIDEO_BITRATE = 30000;

  const currentStats = last(stats);
  const lastStats = nth(-2, stats);

  if (!currentStats || !lastStats || !subscriber.stream) {
    return 0;
  }

  const totalPackets = calculateTotalPackets('video', currentStats, lastStats);
  const packetLoss = getPacketsLost(currentStats.video) - getPacketsLost(lastStats.video) / totalPackets;
  const interval = currentStats.timestamp - lastStats.timestamp;
  let bitrate = calculateBitRate('video', currentStats, lastStats);
  const pixelCount = subscriber.stream.videoDimensions.width * subscriber.stream.videoDimensions.height;
  const targetBitrate = targetBitrateForPixelCount(pixelCount);

  if (bitrate < MIN_VIDEO_BITRATE) {
    return 0;
  }
  bitrate = Math.min(bitrate, targetBitrate);

  const score =
    ((Math.log(bitrate / MIN_VIDEO_BITRATE) / Math.log(targetBitrate / MIN_VIDEO_BITRATE)) * 4) + 1;
  return score;
};

function calculateAudioScore(subscriber: OT.Subscriber, stats: OT.SubscriberStats[]) {
  const audioScore = (rtt: number, plr: number) => {
    const LOCAL_DELAY = 20; // 20 msecs: typical frame duration
    function H(x) { return (x < 0 ? 0 : 1); }
    const a = 0; // ILBC: a=10
    const b = 19.8;
    const c = 29.7;

    const R = (rRtt: number, packetLoss: number): number => {
      const d = rRtt + LOCAL_DELAY;
      const Id = ((0.024 * d) + 0.11) * (d - 177.3) * H(d - 177.3);

      const P = packetLoss;
      const Ie = (a + b) * Math.log(1 + (c * P));

      const rResult = 94.2 - Id - Ie;

      return rResult;
    };

    // R = 94.2 − Id − Ie
    // const R = calcR();

    // For R < 0: MOS = 1
    // For 0 R 100: MOS = 1 + 0.035 R + 7.10E-6 R(R-60)(100-R)
    // For R > 100: MOS = 4.5
    const MOS = (mosR: number) => {
      if (R() < 0) {
        return 1;
      }
      if (R > 100) {
        return 4.5;
      }
      return (1 + 0.035) * ((mosR + (7.10 / 1000000)) * (mosR * (mosR - 60) * (100 - mosR)));
    };

    return MOS(R(rtt, plr));
  };

  const currentStats = last(stats);
  const lastStats = nth(-2, stats);

  if (!currentStats || !lastStats || !subscriber.stream) {
    return 0;
  }
  const totalAudioPackets = calculateTotalPackets('audio', currentStats, lastStats);
  if (totalAudioPackets === 0) {
    return 0;
  }
  const plr = getPacketsLost(currentStats.audio) - getPacketsLost(lastStats.audio) / totalAudioPackets;
  const rtt = 0;
  const score = audioScore(rtt, plr);
  return score;
}


class MOSState {
  statsLog: OT.SubscriberStats[];
  audioScoresLog: number[];
  videoScoresLog: number[];
  bandwidth: Bandwidth;
  intervalId?: number;
  maxLogLength: number;
  scoreInterval: number;

  constructor() {
    this.statsLog = [];
    this.audioScoresLog = [];
    this.videoScoresLog = [];
  }

  static readonly maxLogLength: number = 1000;
  static readonly scoreInterval: number = 1000;

  private audioScore(): number {
    return this.audioScoresLog.reduce((acc, score) => acc + score, 0);
  }

  private videoScore(): number {
    return this.videoScoresLog.reduce((acc, score) => acc + score, 0);
  }

  clearInterval() {
    if (this.intervalId) {
      window.clearInterval(this.intervalId);
    }
    this.intervalId = undefined;
  }

  trimAudioScores() {
    const { audioScoresLog, maxLogLength } = this;
    while (audioScoresLog.length > maxLogLength) {
      audioScoresLog.shift();
    }
    this.audioScoresLog = audioScoresLog;
  }

  trimVideoScores() {
    const { videoScoresLog, maxLogLength } = this;
    while (videoScoresLog.length > maxLogLength) {
      videoScoresLog.shift();
    }
    this.videoScoresLog = videoScoresLog;
  }

  qualityScore(): number {
    return Math.min(this.audioScore(), this.videoScore());
  }
}

function subsriberMOS(subscriber: OT.Subscriber, getStatsListener: StatsListener, callback: MOSResultsCallback) {
  const mosState = new MOSState();
  mosState.intervalId = window.setInterval(
    () => {
      subscriber.getStats((error?: OT.OTError, stats?: OT.SubscriberStats) => {
        if (!stats) {
          return null;
        }
        stats && mosState.statsLog.push(stats);

        if (getStatsListener && typeof getStatsListener === 'function') {
          getStatsListener(error, stats);
        }

        if (mosState.statsLog.length < 2) {
          return null;
        }

        mosState.bandwidth = calculateThroughput(mosState.statsLog);
        const videoScore = calculateVideoScore(subscriber, mosState.statsLog);
        mosState.videoScoresLog.push(videoScore);
        const audioScore = calculateAudioScore(subscriber, mosState.statsLog);
        mosState.audioScoresLog.push(audioScore);


        mosState.trimAudioScores();
        mosState.trimVideoScores();

        // If bandwidth has reached a steady state, end the test early
        if (isBitrateSteadyState(mosState.statsLog)) {
          mosState.clearInterval();
          return callback(mosState.qualityScore(), mosState.bandwidth);
        }

        return null;
      });
    }, mosState.scoreInterval);

  subscriber.on('destroyed', mosState.clearInterval);
  return mosState;
}

export default subsriberMOS;
