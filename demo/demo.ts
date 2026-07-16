import { HemisphereLight, Light, Mesh, PerspectiveCamera, Scene } from "three";
import { GLTFLoader } from "three/examples/jsm/Addons.js";
import {
	color,
	cos,
	float,
	instancedArray,
	instanceIndex,
	PI,
	saturation,
	sin,
	texture,
	time,
	uniform,
} from "three/tsl";
import {
	ACESFilmicToneMapping,
	AmbientLight,
	Color,
	DirectionalLight,
	Fog,
	FogExp2,
	GridHelper,
	LinearToneMapping,
	MeshBasicMaterial,
	MeshNormalMaterial,
	MeshPhysicalNodeMaterial,
	MeshStandardMaterial,
	PlaneGeometry,
	Raycaster,
	ShadowMaterial,
	SphereGeometry,
	WebGPURenderer,
} from "three/webgpu";
import { InstancedAnimatedMesh } from "threejs-instancedanimatedmesh";
import Stats from "three/examples/jsm/libs/stats.module.js";

const stats = new Stats();
stats.showPanel(0);
document.body.appendChild(stats.dom);

export async function demo(
	scene: Scene,
	camera: PerspectiveCamera,
	renderer: WebGPURenderer,
	ldr: GLTFLoader,
) {
	const total = 211;
	const [crabAssets] = await Promise.all([
		ldr.loadAsync("./crab.packed.glb"),
	]);

	const bgColor = new Color("darkgrey");
	scene.background = bgColor;

	scene.add(new HemisphereLight(0, 0xcccccc, 1));
	scene.add(new AmbientLight(0xffffff, 0.1));

	const dirLight = new DirectionalLight(0xffffff, 4);
	dirLight.position.set(5, 10, 7);
	dirLight.castShadow = true;
	dirLight.shadow.mapSize.width = 2048;
	dirLight.shadow.mapSize.height = 2048;
	dirLight.shadow.camera.near = 0.5;
	dirLight.shadow.camera.far = 50;
	dirLight.shadow.camera.left = -20;
	dirLight.shadow.camera.right = 20;
	dirLight.shadow.camera.top = 20;
	dirLight.shadow.camera.bottom = -20;
	scene.add(dirLight);

	//scene.add(sceneAssets.scene);
	scene.add(crabAssets.scene);

	const flashTimeArr = instancedArray(total);

	scene.traverse((o) => {
		if (o instanceof Light) {
			//o.intensity = 1;
		} else if (o instanceof Mesh) {
			o.castShadow = true;
			o.receiveShadow = true;

			const m = o.material as MeshStandardMaterial;

			const flashTime = flashTimeArr.element(instanceIndex).x;
			const duration = 0.3;

			const factor = time.sub(flashTime).div(duration).clamp(0, 1);

			const map = texture(m.map!);
			const accent = saturation(map, 3).clamp(0, 1).mul(1);

			o.material = new MeshPhysicalNodeMaterial({
				colorNode: map.add(accent.mul(factor.oneMinus())),
				roughness: m.roughness,
				roughnessMap: m.roughnessMap,
				normalMap: m.normalMap,
			});
		}
	});

	//add a shadow catcher
	const shadowCatcher = new Mesh(
		new PlaneGeometry(100, 100),
		new ShadowMaterial(),
	);
	shadowCatcher.rotation.x = -Math.PI / 2;
	shadowCatcher.position.y -= 0.1;
	scene.add(shadowCatcher);

	const raycaster = new Raycaster();
	raycaster.layers.set(2);

	// const ground = scene.getObjectByName("ground") as Mesh;
	// ground.geometry.computeBoundsTree();
	// ground.layers.enable(2);

	//-----------

	const imesh = new InstancedAnimatedMesh(
		scene.getObjectByName("worker-rig")!,
		crabAssets.animations,
		total,
	);
	imesh.castShadow = true;
	imesh.receiveShadow = true;
	scene.add(imesh);
	imesh.scale.setScalar(0.04);

	const gridSize = Math.floor(Math.sqrt(total));
	const scale = 30;
	const rratio = 11;

	for (let i = 0; i < total; i++) {
		const crab = imesh.getInstance();
		crab.position.x =
			((i % gridSize) - gridSize / 2) * scale -
			rratio / 2 +
			rratio * Math.random();
		crab.position.z =
			(Math.floor(i / gridSize) - gridSize / 2) * scale -
			rratio / 2 +
			rratio * Math.random();

		if (Math.random() > 0.5) {
			crab.gotoAndPlay("worker-idle");
		} else {
			crab.gotoAndPlay("worker-attack", {
				frameScript: {
					spit: () => {
						flashTimeArr.value.array[crab.idx] = time.value;
						flashTimeArr.value.needsUpdate = true;
					},
				},
			});
		}

		crab.gotoAndPlay("worker-eyes", { channel: "eyes" });
		crab.gotoAndPlay("worker-antenas-loop", { channel: "antenas" });
		crab.scale.setScalar(0.5 + Math.random() * 1);
		crab.rotateY(Math.PI * 2 * Math.random());

		//
		// example. add an object to a bone
		//
		if (i == 0) {
			const hat = new Mesh(
				new SphereGeometry(4),
				new MeshNormalMaterial(),
			);
			crab.getBone("Bone").add(hat);
			hat.position.y = 14;

			//
			// modify the ṕone to AFTER the animation has been applied
			//
			// let rot = 0;
			// crab.modifyPose((api) => {
			// 	rot += 0.01;
			// 	api.getBoneByName("Bone").rotation.y = rot;
			// });
		}
		crab.needsUpdate = true;
		scene.add(crab);
	}

	let lastTime = 0;

	return (elapsed: number) => {
		const dt = elapsed - lastTime;
		lastTime = elapsed;

		imesh.update(dt, renderer);
		stats.update();
	};
}
