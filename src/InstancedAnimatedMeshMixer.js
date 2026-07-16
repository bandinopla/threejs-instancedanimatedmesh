import * as THREE from "three/webgpu";

/** @typedef {import("./InstancedAnimatedMeshPlayParams").InstancedAnimatedMeshPlayParams} PlayConfig */


/**
 * This class keeps track of the animation state of each instance.
 * It is used by the InstancedAnimatedMesh to play animations on multiple instances.
 */
export class InstancedAnimatedMeshMixer {


	/** @type {Map<number, PlayConfig["frameScript"]>} */
	instanceFrameListeners;

	/**
	 * 
	 * @param {THREE.AnimationMixer} realMixer 
	 * @param {THREE.AnimationClip[]} clips 
	 */
	constructor(realMixer, clips, FPS = 24) {

		this._mixer = realMixer;
		this._actions = new Map();

		this.frameScripts = new Map();
		this.instanceFrameListeners = new Map();

		this._fps = FPS;
		this._frameTime = 1 / FPS;

		clips.sort((a, b) => {
			if (a.userData.additive) return 1;
			if (b.userData.additive) return -1;
			return 0;
		})



		clips.forEach(c => {
			const action = this._mixer.clipAction(c);

			for (const prop in c.userData) {

				if (prop === "additive") {
					action.blendMode = THREE.AdditiveAnimationBlendMode;
					continue;
				}

				if (!this.frameScripts.has(c)) {
					this.frameScripts.set(c, []);
				}

				const propValue = c.userData[prop];



				if (prop.includes("@")) {
					const [eventName, frame] = prop.split("@");
					this.frameScripts.get(c).push([eventName, Number(frame) * this._frameTime, propValue]);
				} else {

					if (typeof propValue !== "number")
						continue

					// [ event name, frame time ]
					this.frameScripts.get(c).push([prop, propValue * this._frameTime]);
				}
			}

			this._actions.set(c.name, action);
		});

		this._instances = new Array(1000); // Dense array mapping (will grow if needed)
		for (let i = 0; i < 1000; i++) this._instances[i] = [];

		this._trackPool = [];

		const self = this;
	}

	_getTracks(instanceIndex) {
		let arr = this._instances[instanceIndex];
		if (!arr) {
			arr = [];
			this._instances[instanceIndex] = arr;
		}
		return arr;
	}

	clearInstance(instanceIndex) {
		const tracks = this._instances[instanceIndex];
		if (tracks) {
			for (let i = 0; i < tracks.length; i++) {
				this._trackPool.push(tracks[i]);
			}
			tracks.length = 0; // clear without allocating a new array
		}
		this.instanceFrameListeners.delete(instanceIndex);
	}

	_play(instanceIndex, name, config = {}) {

		const tracks = this._getTracks(instanceIndex);
		const { loop = true, crossfadeDuration = 0, weight = 1, timeScale = 1, channel = "main" } = config;

		//remove old listeners
		if (channel === "main") {
			this.instanceFrameListeners.delete(instanceIndex);
		}

		if (config.frameScript && channel === "main") {
			this.instanceFrameListeners.set(instanceIndex, config.frameScript);
		}

		// Find existing track
		let existingIdx = -1;
		for (let i = 0; i < tracks.length; i++) {
			if (tracks[i].name === name) {
				existingIdx = i;
				break;
			}
		}

		if (existingIdx !== -1) {
			this._trackPool.push(tracks[existingIdx]);
			tracks.splice(existingIdx, 1);
		}

		if (crossfadeDuration > 0) {
			for (let i = 0; i < tracks.length; i++) {
				const t = tracks[i];
				if (t.channel === channel && t.fade !== 'out') {
					t.fade = 'out';
					t.fadeDuration = crossfadeDuration;
					t.fadeElapsed = 0;
					t.fadeStartWeight = t.weight;
				}
			}
		} else {
			// Remove all tracks with same channel in-place
			for (let i = tracks.length - 1; i >= 0; i--) {
				if (tracks[i].channel === channel) {
					this._trackPool.push(tracks[i]);
					tracks.splice(i, 1);
				}
			}
		}

		// Pool or create new track
		let newTrack = this._trackPool.pop();
		if (!newTrack) newTrack = {};

		newTrack.offset = instanceIndex * .25;
		newTrack.name = name;
		newTrack.time = loop ? newTrack.offset : 0; //loop ? Math.random() * this._actions.get(name).getClip().duration : 0;
		newTrack.weight = crossfadeDuration > 0 ? 0 : weight;
		newTrack.targetWeight = weight;
		newTrack.timeScale = timeScale;
		newTrack.loop = loop;
		newTrack.paused = false;
		newTrack.fade = crossfadeDuration > 0 ? 'in' : null;
		newTrack.fadeDuration = crossfadeDuration;
		newTrack.fadeElapsed = 0;
		newTrack.channel = channel;
		newTrack.lastEvalTime = newTrack.time;
		newTrack.completeEmitter = false;

		tracks.push(newTrack);
		// console.log("PLAY CLIP", name, "TIME", tracks.at(-1).time, this._actions.get(name).getClip())
	}

	_stop(instanceIndex, name, fadeDuration) {
		const tracks = this._getTracks(instanceIndex);
		for (let i = tracks.length - 1; i >= 0; i--) {
			const t = tracks[i];
			if (name && t.name !== name) continue;

			if (fadeDuration > 0) {
				t.fade = 'out';
				t.fadeDuration = fadeDuration;
				t.fadeElapsed = 0;
				t.fadeStartWeight = t.weight;
			} else {
				this._trackPool.push(t);
				tracks.splice(i, 1);
			}
		}
	}

	_pause(instanceIndex, name) {
		const tracks = this._getTracks(instanceIndex);
		for (let i = 0; i < tracks.length; i++) {
			const t = tracks[i];
			if (!name || t.name === name) t.paused = true;
		}
	}

	_resume(instanceIndex, name) {
		const tracks = this._getTracks(instanceIndex);
		for (let i = 0; i < tracks.length; i++) {
			const t = tracks[i];
			if (!name || t.name === name) t.paused = false;
		}
	}

	update(instanceIndex, delta) {
		const tracks = this._getTracks(instanceIndex);

		for (let i = tracks.length - 1; i >= 0; i--) {
			const t = tracks[i];



			if (!t.paused) {
				t.time += delta * t.timeScale;
			};

			if (t.fade) {
				t.fadeElapsed += delta;
				const alpha = Math.min(t.fadeElapsed / t.fadeDuration, 1);

				if (t.fade === 'in') {
					t.weight = alpha * t.targetWeight;
					if (alpha >= 1) t.fade = null;
				} else {
					t.weight = t.fadeStartWeight * (1 - alpha);
					if (alpha >= 1) {
						tracks.splice(i, 1);
						continue;
					}
				}
			}
		}

		this.apply(instanceIndex);

		return tracks[0].offset;
	}

	apply(instanceIndex) {
		const tracks = this._getTracks(instanceIndex);
		this._actions.forEach(action => { action.enabled = false; });

		tracks.forEach(t => {

			/**
			 * @type {THREE.AnimationAction}
			 */
			const action = this._actions.get(t.name);


			if (!action) return;
			if (!action.isRunning()) {
				action.reset();
				action.play()
			}
			;

			const clip = action.getClip();
			const duration = clip.duration;
			let emitComplete = false;

			if (t.time >= duration) {


				if (!t.loop) {
					t.paused = true;
					t.time = duration;
				}
				else {
					t.time -= duration;
				}

				if (!t.completeEmitter) {
					emitComplete = true;
					t.completeEmitter = true;
				}
			}

			action.enabled = true;
			action.paused = t.paused;
			action.time = t.time;
			action.timeScale = t.timeScale;
			action.setLoop(t.loop ? THREE.LoopRepeat : THREE.LoopOnce, t.loop ? Infinity : 1)
			action.clampWhenFinished = !t.loop;
			action.setEffectiveWeight(t.weight);


			if (!t.paused || emitComplete) {
				this._execFrameScript(instanceIndex, action, t, emitComplete);
			}
		});

	}

	_execFrameScript(instanceIndex, action, track, emitComplete = false) {
		const clip = action.getClip();
		const scripts = this.frameScripts.get(clip);
		const frameScript = this.instanceFrameListeners.get(instanceIndex);

		let lastTime = track.lastEvalTime ?? 0;
		let currTime = track.time;

		if (currTime < lastTime || emitComplete) {
			// A loop rollover occurred or finished! Evaluate the end of the previous loop...
			this._triggerEventsInRange(scripts, frameScript, lastTime, clip.duration);
			// ...and reset lastTime for the new loop start
			lastTime = 0;
		}

		// Evaluate normal forward time movement
		this._triggerEventsInRange(scripts, frameScript, lastTime, currTime);

		// Emit complete AFTER all frame scripts
		if (emitComplete) {
			frameScript?.$complete?.();
		}

		track.lastEvalTime = currTime;
	}

	_triggerEventsInRange(scripts, frameScript, startTime, endTime) {
		if (!scripts || !frameScript) return;
		for (let i = 0; i < scripts.length; i++) {
			const [name, frameTime, value] = scripts[i];
			// Trigger if frameTime is strictly after startTime, and up to (and including) endTime
			if (frameTime > startTime && frameTime <= endTime) {
				if (frameScript[name]) {
					frameScript[name](value);
				}
			}
		}
	}
}