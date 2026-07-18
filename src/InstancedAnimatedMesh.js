import * as THREE from "three/webgpu";
import {
	add,
	attributeArray,
	call,
	cameraViewMatrix,
	cross,
	dot,
	Fn,
	instanceIndex,
	mat3,
	normalize,
	normalMap,
	storage,
	texture,
	transformNormalToView,
	uint,
	uniform,
	vec3,
	vec4,
	vertexIndex,
} from "three/tsl";
import { InstancedAnimatedMeshMixer } from "./InstancedAnimatedMeshMixer.js";

const _mat4 = new THREE.Matrix4();
const _mat4b = new THREE.Matrix4();
const rot = new THREE.Quaternion();
const v = new THREE.Vector3();

/**
 * @typedef {Object} InstancedAnimatedMeshApi
 * @property {number} instanceIndex
 * @property {(boneName: string) => THREE.Matrix4} getBoneMatrix
 * @property {(boneName: string) => THREE.Bone} getBoneByName
 * @property {(object: THREE.Object3D, boneName: string) => void} placeAtBone
 */

/**
 * @author https://github.com/RenaudRohlinger ( IDEATOR )
 * @author https://github.com/bandinopla ( THIS SUGAR WRAPPER )
 * @author https://claude.ai ( CODE GENERATOR )
 *
 * @see https://github.com/mrdoob/three.js/pull/33644 
 */
export class InstancedAnimatedMesh extends THREE.Object3D {


	_elapsed = 0;

	/**
	 * @type {SkinnedMeshInstance[]}
	 */
	_pool = []

	/**
	 * @type {(idx:number)=>boolean}
	 */
	canUpdateInstance;

	/**
	 * @param {THREE.Object3D} rig  — all skinned meshes sharing one skeleton
	 * @param {THREE.AnimationClip[]} clips
	 * @param {number} instanceCount
	 */
	constructor(rig, clips, instanceCount, FPS = 24) {

		super();
		this.instanceCount = instanceCount;

		/**
		 * @type {THREE.SkinnedMesh[]}
		 */
		const skinnedMeshes = [];
		rig.traverse((o) => {
			if (o instanceof THREE.SkinnedMesh) {
				skinnedMeshes.push(o);
			}
		});
		this._skinnedMeshes = skinnedMeshes;


		clips = clips.map(c => {
			if (c.userData.additive) {
				let refFrame = 1;
				let refClip = undefined;

				if (typeof c.userData.additive == "string") {
					refClip = clips.find(_c => _c.name == c.userData.additive);
					if (!refClip) {
						throw new Error(`Additive clip "${c.name}": points to ref clip "${c.userData.additive}" not found`)
					}
				}

				const clone = THREE.AnimationUtils.makeClipAdditive(c.clone(), refFrame, refClip);
				clone.name = c.name;
				return clone;
			}
			else {
				return c;
			}
		});

		this.clips = clips;

		this.root = this;

		// --- reference animated object (drives the skeleton) ---
		this._referenceMesh = skinnedMeshes[0];
		this._skeleton = this._referenceMesh.skeleton;
		this._mixer = new THREE.AnimationMixer(rig
		);

		this._shadowMixer = new InstancedAnimatedMeshMixer(this._mixer, clips, FPS);

		// --- per-instance state --- 
		this._matrices = new Array(instanceCount).fill(null); // THREE.Matrix4 per instance

		// --- GPU buffers ---
		const boneCount = this._skeleton.bones.length;
		this._boneCount = boneCount;

		this._boneMatricesAttr = new THREE.StorageBufferAttribute(
			instanceCount * boneCount,
			16,
		);
		this._instanceMatricesAttr = new THREE.StorageBufferAttribute(
			instanceCount,
			16,
		);

		const boneMatricesNode = storage(
			this._boneMatricesAttr,
			"mat4",
			this._boneMatricesAttr.count,
		).toReadOnly();
		const instanceMatricesNode = storage(
			this._instanceMatricesAttr,
			"mat4",
			instanceCount,
		).toReadOnly();

		// --- build one computed mesh per skinned mesh ---
		this._computeNodes = [];
		for (const source of skinnedMeshes) {

			source.geometry.computeTangents();


			const { mesh, computeNode } = this._buildComputedMesh(
				source,
				instanceCount,
				boneCount,
				boneMatricesNode,
				instanceMatricesNode,
			);
			this.root.add(mesh);
			this._computeNodes.push(computeNode);
		}

		// hide source meshes
		for (const sm of skinnedMeshes) sm.visible = false;

		this._beforeSkeletonUpdate = [];
		this._afterSkeletonUpdate = [];

		//---


		/** @type {InstancedAnimatedMeshApi} */
		this._sharedApi = {
			instanceIndex: 0,
			getBoneMatrix: (boneName) => {
				return this._getMatrixOfBone(this._sharedApi.instanceIndex, boneName);
			},
			getBoneByName: (boneName) => {
				return this._getBoneByName(boneName);
			},
			placeAtBone: (object, boneName) => {
				this._placeObjectAtBone(this._sharedApi.instanceIndex, object, boneName);
			}
		};
	}

	set castShadow(val) {
		this.root?.children.forEach(c => c.castShadow = val);
	}
	get castShadow() {
		return this.root?.children[0].castShadow;
	}

	set receiveShadow(val) {
		this.root?.children.forEach(c => c.receiveShadow = val);
	}
	get receiveShadow() {
		return this.root?.children[0].receiveShadow;
	}


	beforeSkeletonUpdate(idx, callback) {
		// const api = {
		// 	getBoneMatrix: this._getMatrixOfBone.bind(this, idx),
		// 	getBoneByName: this._getBoneByName.bind(this),
		// 	placeAtBone: this._placeObjectAtBone.bind(this, idx)
		// };

		// this._beforeSkeletonUpdate[idx] = () => callback(api);
		this._beforeSkeletonUpdate[idx] = callback;
	}

	afterSkeletonUpdate(idx, callback) {
		this._afterSkeletonUpdate[idx] = callback;
	}

	// -------------------------------------------------------------------------

	/**
	 * Register an instance. Returns its index.
	 * @param {THREE.Matrix4|null} matrix  — optional initial world matrix
	 * @param {string|null} clipName
	 * @param {number} timeOffset
	 */
	_addInstance(matrix = null, clipName = null, timeOffset = 0) {
		const idx = this._nextIndex ?? 0;
		this._nextIndex = idx + 1;

		if (idx >= this.instanceCount) {
			throw new Error("InstancedAnimatedMesh: exceeded instanceCount");
		}

		this._matrices[idx] = matrix ?? new THREE.Matrix4();

		if (clipName) this.play(idx, clipName, timeOffset);

		this._writeMatrix(idx);
		return idx;
	}

	getInstance() {
		let instance = this._pool.find(i => i._free);
		if (!instance) {
			instance = new SkinnedMeshInstance(this, this._addInstance());
			this._pool.push(instance);
		}

		instance._free = false;
		return instance;
	}

	/**
	 * Set the world matrix for an instance.
	 * @param {number} idx
	 * @param {THREE.Matrix4} matrix
	 */
	setMatrix(idx, matrix) {
		this._matrices[idx] = matrix;
	}

	/**
	 * Hides the instance, clears any running animations, and removes callbacks.
	 * Moves it to a zero-scale matrix so it disappears from the render view.
	 * @param {number} idx 
	 */
	removeInstance(idx) {
		// Stop animations and clear out mixer data for this instance
		this._shadowMixer.clearInstance(idx);

		// Remove per-instance skeleton hooks
		this._beforeSkeletonUpdate[idx] = null;

		// Hide the item by moving it out of bounds and scaling to 0
		const nullMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
		this.setMatrix(idx, nullMatrix);
		this._writeMatrix(idx);

		this._boneMatricesAttr.addUpdateRange(
			idx * this._boneCount * 16,
			this._boneCount * 16
		);
		this._instanceMatricesAttr.addUpdateRange(idx * 16, 16);
		this._boneMatricesAttr.needsUpdate = true;
		this._instanceMatricesAttr.needsUpdate = true;
	}

	/**
	 * Play a clip on an instance.
	 * @param {number} idx
	 * @param {string} clipName
	 * @param {Partial<import("./InstancedAnimatedMeshPlayParams").InstancedAnimatedMeshPlayParams>} config 
	 */
	play(idx, clipName, config) {

		//this._shadowMixer.for(idx).play(clipName, config);
		this._shadowMixer._play(idx, clipName, config);
	}

	/**
	 * Call every frame.
	 * @param {number} delta   — delta time (seconds)
	 * @param {THREE.WebGPURenderer} renderer
	 */
	update(delta, renderer) {

		this._elapsed += delta;

		let anythingUpdated = false;
		let updatedCount = 0;

		let lastBoneMatrix = null;

		for (let i = 0; i < (this._nextIndex ?? 0); i++) {


			if (this.canUpdateInstance?.(i) === false) continue;

			const instance = this._pool[i];
			if (!instance || instance._free) continue;

			anythingUpdated = true;
			updatedCount++;

			if (instance.needsUpdate) {
				instance.updateMatrixWorld(true);
				this.setMatrix(i, instance.matrixWorld);
				instance.needsUpdate = false;
			}

			const idx = instance.idx;

			const ioffset = this._shadowMixer.update(idx, delta);


			//this._mixer.setTime(this._elapsed + ioffset);
			this._mixer.update(0)

			//----------------------------------------------------------------------------------------------

			this._referenceMesh.parent?.updateMatrixWorld(true);

			if (this._beforeSkeletonUpdate[i]) {
				this._sharedApi.instanceIndex = i;
				this._beforeSkeletonUpdate[i](this._sharedApi); //<---- CHANGING BONES POSITIONS
				this._referenceMesh.parent?.updateMatrixWorld(true);
			}

			this._skeleton.update();

			// copy bone matrices for this instance into the flat buffer
			this._boneMatricesAttr.array.set(
				this._skeleton.boneMatrices,
				idx * this._boneCount * 16,
			);


			this._writeMatrix(idx);

			this._boneMatricesAttr.addUpdateRange(
				i * this._boneCount * 16, // start index
				this._boneCount * 16      // count
			);
			this._instanceMatricesAttr.addUpdateRange(
				i * 16, // start index
				16      // count
			);

			//---
			if (this._afterSkeletonUpdate[i]) {
				//this._referenceMesh.parent?.updateMatrixWorld(true);
				this._sharedApi.instanceIndex = i;
				this._afterSkeletonUpdate[i](this._sharedApi);

				if (this.updatedCount > this.instanceCount * 0.5) {
					this._instanceMatricesAttr.clearUpdateRanges()
					this._boneMatricesAttr.clearUpdateRanges()
				}
			}

		}


		if (anythingUpdated) {
			this._boneMatricesAttr.needsUpdate = true;
			this._instanceMatricesAttr.needsUpdate = true;

			const totalInstances = this._nextIndex ?? 0;
			if (updatedCount > totalInstances * 0.5) {
				this._boneMatricesAttr.clearUpdateRanges();
				this._instanceMatricesAttr.clearUpdateRanges();
			}
		}

		for (const node of this._computeNodes) renderer.compute(node);
	}

	_getBoneByName(boneName) {
		return this._skeleton.bones.find((b) => b.name === boneName);
	}

	_getMatrixOfBone(idx, boneName) {
		const bone = this._getBoneByName(boneName);
		if (!bone) {

			throw new Error(`InstancedAnimatedMesh: bone "${boneName}" not found`);
		}

		/**
		 * @type {THREE.Matrix4}
		 */
		const result = _mat4b.copy(this._matrices[idx]);

		// return bone.matrixWorld;
		const boneLocalMatrix = _mat4
			.copy(this._referenceMesh.matrixWorld)
			.invert()
			.multiply(bone.matrixWorld);

		const instanceBoneMatrix = result.multiply(boneLocalMatrix);

		instanceBoneMatrix.premultiply(this.matrixWorld);

		return instanceBoneMatrix;
	}

	_placeObjectAtBone(idx, object, boneName) {

		const boneWorldMatrix = this._getMatrixOfBone(idx, boneName);

		object.parent.updateWorldMatrix(true, false);
		boneWorldMatrix.premultiply(object.parent.matrixWorld.clone().invert());

		boneWorldMatrix.decompose(object.position, object.quaternion, object.scale);
	}
	// _placeObjectAtBone(idx, object, boneName) {

	// 	const boneWorldMatrix = this._getMatrixOfBone(idx, boneName);

	// 	boneWorldMatrix.decompose(object.position, object.quaternion, object.scale);

	// 	object.parent.getWorldScale(v);
	// 	object.scale.divide(v);

	// 	object.parent.getWorldQuaternion(rot);

	// 	object.parent.worldToLocal(object.position);
	// 	object.quaternion.copy(rot.invert().multiply(object.quaternion));
	// }

	// -------------------------------------------------------------------------
	//  Internals
	// -------------------------------------------------------------------------

	_writeMatrix(idx) {
		_mat4.copy(this._matrices[idx]);
		if (this._rootCorrection) _mat4.premultiply(this._rootCorrection);
		_mat4.toArray(this._instanceMatricesAttr.array, idx * 16);

	}

	_createSourceVertexAttribute(geometry) {
		const position = geometry.getAttribute("position");
		const normal = geometry.getAttribute("normal");
		const tangent = geometry.getAttribute("tangent"); // Add this



		const data = new Float32Array(position.count * 12); // pos(4) + normal(4) + tangent(4)

		for (let i = 0; i < position.count; i++) {
			const o = i * 12;
			data[o + 0] = position.getX(i);
			data[o + 1] = position.getY(i);
			data[o + 2] = position.getZ(i);
			// data[o+3] padding
			data[o + 4] = normal.getX(i);
			data[o + 5] = normal.getY(i);
			data[o + 6] = normal.getZ(i);
			// data[o+7] padding
			// Add tangent with handedness
			data[o + 8] = tangent.getX(i);
			data[o + 9] = tangent.getY(i);
			data[o + 10] = tangent.getZ(i);
			data[o + 11] = tangent.getW(i); // handedness
		}

		return new THREE.StorageBufferAttribute(data, 4);
	}

	_buildComputedMesh(
		source,
		instanceCount,
		boneCount,
		boneMatricesNode,
		instanceMatricesNode,
	) {
		const geometry = source.geometry.clone();
		const material = source.material.clone();
		const vertexCount = geometry.getAttribute("position").count;

		const sourceVertices = storage(
			this._createSourceVertexAttribute(geometry),
			"vec4",
			vertexCount * 3, //3 vec4s per vertex: position, normal, tangent
		).toReadOnly();

		const skinIndices = storage(
			new THREE.StorageBufferAttribute(
				new Uint32Array(geometry.getAttribute("skinIndex").array),
				4,
			),
			"uvec4",
			vertexCount,
		).toReadOnly();

		const skinWeights = storage(
			new THREE.StorageBufferAttribute(
				geometry.getAttribute("skinWeight").array,
				4,
			),
			"vec4",
			vertexCount,
		).toReadOnly();

		const bindMatrix = uniform(source.bindMatrix, "mat4");
		const bindMatrixInverse = uniform(source.bindMatrixInverse, "mat4");

		// Output: 3 vec4s per vertex per instance (position, normal, tangent)
		const vertices = attributeArray(instanceCount * vertexCount * 3, "vec4");


		const computeNode = Fn(() => {
			const sourceVertex = instanceIndex.mod(uint(vertexCount));
			const meshInstance = instanceIndex.div(uint(vertexCount));
			const sourceOffset = sourceVertex.mul(uint(3));
			const targetOffset = instanceIndex.mul(uint(3));
			const boneOffset = meshInstance.mul(uint(boneCount));

			const skinIndex = skinIndices.element(sourceVertex);
			const skinWeight = skinWeights.element(sourceVertex);

			const skinVertex = bindMatrix.mul(
				sourceVertices.element(sourceOffset).xyz,
			);

			const boneMatX = boneMatricesNode.element(boneOffset.add(skinIndex.x));
			const boneMatY = boneMatricesNode.element(boneOffset.add(skinIndex.y));
			const boneMatZ = boneMatricesNode.element(boneOffset.add(skinIndex.z));
			const boneMatW = boneMatricesNode.element(boneOffset.add(skinIndex.w));

			const skinMatrix = add(
				skinWeight.x.mul(boneMatX),
				skinWeight.y.mul(boneMatY),
				skinWeight.z.mul(boneMatZ),
				skinWeight.w.mul(boneMatW),
			);

			const skinPosition = bindMatrixInverse.mul(add(
				boneMatX.mul(skinWeight.x).mul(skinVertex),
				boneMatY.mul(skinWeight.y).mul(skinVertex),
				boneMatZ.mul(skinWeight.z).mul(skinVertex),
				boneMatW.mul(skinWeight.w).mul(skinVertex),
			)).xyz;

			// This matrix transforms directions (normals/tangents) from bind pose to animated pose
			const normalMatrix = bindMatrixInverse.mul(skinMatrix).mul(bindMatrix);

			const skinNormal = normalMatrix
				.transformDirection(
					sourceVertices.element(sourceOffset.add(uint(1))).xyz,
				).xyz;

			const sourceTangent = sourceVertices.element(sourceOffset.add(uint(2)));
			const skinTangent = normalMatrix  // Use same matrix as normal
				.transformDirection(sourceTangent.xyz)
				.xyz;

			const instanceMatrix = instanceMatricesNode.element(meshInstance);

			vertices.element(targetOffset).assign(
				vec4(instanceMatrix.mul(skinPosition).xyz, 1),
			);
			vertices.element(targetOffset.add(uint(1))).assign(
				vec4(instanceMatrix.transformDirection(skinNormal), 0),
			);
			// Write tangent (keep handedness in w)
			vertices.element(targetOffset.add(uint(2))).assign(
				vec4(instanceMatrix.transformDirection(skinTangent), sourceTangent.w),
			);
		})().compute(instanceCount * vertexCount).setName(
			`ComputeSkinning_${source.name}`,
		);


		const meshVertex = instanceIndex.mul(uint(vertexCount)).add(vertexIndex)
			.mul(uint(3));

		material.positionNode = vertices.element(meshVertex).xyz;



		const worldSpaceNormal = vertices.element(meshVertex.add(uint(1))).xyz;
		const instanceNormal = worldSpaceNormal.transformDirection(cameraViewMatrix).normalize().toVarying();

		if (material.normalMap) {

			const instanceTangentData = vertices.element(meshVertex.add(uint(2)));
			let instanceTangent = transformNormalToView(instanceTangentData.xyz).normalize();
			instanceTangent = instanceTangent.sub(instanceNormal.mul(dot(instanceNormal, instanceTangent))).normalize();
			instanceTangent = instanceTangent.toVarying();

			const instanceBitangent = cross(instanceNormal, instanceTangent).mul(instanceTangentData.w);

			const TBN = mat3(instanceTangent, instanceBitangent, instanceNormal);
			// const mapN = texture(material.normalMap).rgb.mul(2).sub(1); 
			// material.normalNode = TBN.mul(mapN).normalize();
			const normalScale = uniform(material.normalScale);
			const mapN = texture(material.normalMap).rgb.mul(2).sub(1);
			const scaledMapN = vec3(mapN.xy.mul(normalScale), mapN.z);
			material.normalNode = TBN.mul(scaledMapN).normalize();

		} else {
			// Fallback if there is no normal map texture
			// material.normalNode = instanceNormal;
			material.normalNode = transformNormalToView(vertices.element(meshVertex.add(uint(1))).xyz).toVarying();
		}


		const mesh = new THREE.Mesh(geometry, material);
		mesh.count = instanceCount;
		//mesh.castShadow = true;
		//mesh.receiveShadow = true;
		mesh.frustumCulled = false;

		return { mesh, computeNode };
	}
}


export class SkinnedMeshInstance extends THREE.Object3D {

	_free = true;

	_boneGhosts = new Map();

	/**
	 * 
	 * @param {InstancedAnimatedMesh} imesh 
	 * @param {number} idx 
	 */
	constructor(imesh, idx) {
		super();
		this.imesh = imesh;
		this.idx = idx;
		this.needsUpdate = true;
	}

	/**  
	 * Will go to that clip and play in a loop
	 * @param {string} clipName 
	 * @param {Partial<import("./InstancedAnimatedMeshPlayParams").InstancedAnimatedMeshPlayParams>} config 
	 */
	gotoAndPlay(clipName, config = {}) {
		this.imesh.play(this.idx, clipName, { ...config, loop: true });
	}

	/**  
	 * Will go to that clip and then stop at the end
	 * @param {string} clipName 
	 * @param {Partial<import("./InstancedAnimatedMeshPlayParams").InstancedAnimatedMeshPlayParams>} config 
	 */
	gotoAndStop(clipName, config = {}) {
		this.imesh.play(this.idx, clipName, { ...config, loop: false });
	}

	/**
	 * WIll lazy create an object that will be synced with the rig's bone
	 * @param {string} boneName 
	 */
	getBone(boneName) {
		let boneGhost = this._boneGhosts.get(boneName);
		if (!boneGhost) {
			boneGhost = new THREE.Object3D();
			this._boneGhosts.set(boneName, boneGhost);
			this.add(boneGhost);

			if (this._boneGhosts.size == 1) {
				this.imesh.afterSkeletonUpdate(this.idx, (api) => {
					for (const [boneName, boneGhost] of this._boneGhosts) {
						api.placeAtBone(boneGhost, boneName);
					}
				});
			}
		}
		return boneGhost;
	}

	clearBone(boneName) {
		const boneGhost = this._boneGhosts.get(boneName);
		if (boneGhost) {
			this.remove(boneGhost);
			this._boneGhosts.delete(boneName);
			if (this._boneGhosts.size == 0) {
				this.imesh.afterSkeletonUpdate(this.idx, null);
			}
		}
	}

	/**
	 * Allows you to modify the pose of the skeleton after the animation pose has been calculated
	 * @param {(api: InstancedAnimatedMeshApi) => void} hook
	 */
	modifyPose(hook) {

		if (!hook) {
			this.imesh.beforeSkeletonUpdate(this.idx, null);
		} else {
			this.imesh.beforeSkeletonUpdate(this.idx, hook);
		}
	}

}
