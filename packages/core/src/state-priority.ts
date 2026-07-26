import type { SemanticState } from '@agent-glow/protocol/semantic-state';

const statePriority: Readonly<Record<SemanticState, number>> = {
	idle: 0,
	paused: 1,
	working: 2,
	success: 3,
	waiting_permission: 4,
	error: 5,
};

export function selectHighestPriorityState(states: readonly SemanticState[]): SemanticState {
	return states.reduce<SemanticState>((selected, state) => {
		return statePriority[state] > statePriority[selected] ? state : selected;
	}, 'idle');
}
