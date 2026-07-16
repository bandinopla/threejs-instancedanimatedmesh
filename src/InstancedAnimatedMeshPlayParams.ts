export type InstancedAnimatedMeshPlayParams = {
	loop: boolean;
	crossfadeDuration: number;
	weight: number;
	timeScale: number;
	channel: string;

	frameScript: {
		$complete?: (payload?: string) => void;
		[event: string]: ((payload?: string) => void) | undefined;
	};
};
