// Hatchery overlord: spawn and run a dedicated supplier-like hatchery attendant (called after colony has storage)
import {Overlord} from '../Overlord';
import {Zerg} from '../../zerg/Zerg';
import {Tasks} from '../../tasks/Tasks';
import {log} from '../../console/log';
import {OverlordPriority} from '../../priorities/priorities_overlords';
import {profile} from '../../profiler/decorator';
import {mergeSum, minBy} from '../../utilities/utils';
import {StoreStructure} from '../../declarations/typeGuards';
import {Colony} from '../../Colony';
import {$} from '../../caching';
import {
	bunkerChargingSpots,
	getPosFromBunkerCoord,
	insideBunkerBounds,
	quadrantFillOrder
} from '../../roomPlanner/layouts/bunker';
import {TransportRequestGroup} from '../../logistics/TransportRequestGroup';
import {Task} from '../../tasks/Task';
import {Hatchery} from '../../hiveClusters/hatchery';
import {QueenSetup} from './queen';
import {Pathing} from '../../movement/Pathing';

type rechargeObjectType = StructureStorage
	| StructureTerminal
	| StructureContainer
	| StructureLink
	| Tombstone
	| Resource;

type SupplyStructure = StructureExtension | StructureSpawn | StructureTower | StructureLab;

function isSupplyStructure(structure: Structure): structure is SupplyStructure {
	return structure.structureType == STRUCTURE_EXTENSION
		   || structure.structureType == STRUCTURE_LAB
		   || structure.structureType == STRUCTURE_TOWER
		   || structure.structureType == STRUCTURE_SPAWN;
}

function computeQuadrant(colony: Colony, quadrant: Coord[]): SupplyStructure[] {
	let positions = _.map(quadrant, coord => getPosFromBunkerCoord(coord, colony));
	let structures: SupplyStructure[] = [];
	for (let pos of positions) {
		let structure = _.find(pos.lookFor(LOOK_STRUCTURES), s => isSupplyStructure(s)) as SupplyStructure | undefined;
		if (structure) {
			structures.push(structure);
		}
	}
	return structures;
}

@profile
export class BunkerQueenOverlord extends Overlord {

	room: Room;
	transportRequests: TransportRequestGroup;
	queens: Zerg[];
	storeStructures: StoreStructure[];
	batteries: StructureContainer[];
	quadrants: { [quadrant: string]: SupplyStructure[] };
	assignments: { [queenName: string]: SupplyStructure[] };

	constructor(hatchery: Hatchery, priority = OverlordPriority.core.queen) {
		super(hatchery, 'supply', priority);
		this.transportRequests = this.colony.transportRequests;
		this.queens = _.sortBy(this.zerg(QueenSetup.role), creep => creep.name);
		this.batteries = _.filter(this.room.containers, container => insideBunkerBounds(container.pos, this.colony));
		this.storeStructures = _.compact([this.colony.terminal!, this.colony.storage!, ...this.batteries]);
		this.quadrants = {
			lowerRight: $.structures(this, 'LR',
									 () => computeQuadrant(this.colony, quadrantFillOrder.lowerRight)),
			upperLeft : $.structures(this, 'UL',
									 () => computeQuadrant(this.colony, quadrantFillOrder.upperLeft)),
			lowerLeft : $.structures(this, 'LL',
									 () => computeQuadrant(this.colony, quadrantFillOrder.lowerLeft)),
			upperRight: $.structures(this, 'UR',
									 () => computeQuadrant(this.colony, quadrantFillOrder.upperRight)),
		};
		// Assign quadrants to queens
		this.assignments = _.zipObject(_.map(this.queens, queen => [queen.name, []]));
		let activeQueens = _.filter(this.queens, queen => !queen.spawning);
		if (activeQueens.length >= 1) {
			let quadrantAssignmentOrder = [this.quadrants.lowerRight,
										   this.quadrants.upperLeft,
										   this.quadrants.lowerLeft,
										   this.quadrants.upperRight];
			let i = 0;
			for (let quadrant of quadrantAssignmentOrder) {
				let queen = activeQueens[i % activeQueens.length];
				this.assignments[queen.name] = this.assignments[queen.name].concat(quadrant);
				i++;
			}
		}
	}

	init() {
		let amount = 1;
		if (this.colony.spawns.length > 1) {
			amount = 2;
		}
		this.wishlist(amount, QueenSetup);
	}

	// Builds a series of tasks to empty unnecessary carry contents, withdraw required resources, and supply structures
	private buildSupplyTaskManifest(queen: Zerg): Task | null {
		let tasks: Task[] = [];
		// Step 1: empty all contents (this shouldn't be necessary since queen is normally empty at this point)
		let queenPos = queen.pos;
		if (_.sum(queen.carry) > 0) {
			let transferTarget = this.colony.terminal || this.colony.storage || this.batteries[0];
			if (transferTarget) {
				tasks.push(Tasks.transferAll(transferTarget));
				queenPos = transferTarget.pos;
			} else {
				log.warning(`No transfer targets for ${queen.name}@${queen.pos.print}!`);
				return null;
			}
		}
		// Step 2: figure out what you need to supply for and calculate the needed resources
		let queenCarry = {} as { [resourceType: string]: number };
		let allStore = mergeSum(_.map(this.storeStructures, s => s.store));
		let allSupplyRequests = _.compact(_.flatten(_.map(this.assignments[queen.name],
														  struc => this.transportRequests.supplyByID[struc.id])));
		let supplyTasks: Task[] = [];
		for (let request of allSupplyRequests) {
			// stop when carry will be full
			let remainingAmount = queen.carryCapacity - _.sum(queenCarry);
			if (remainingAmount == 0) break;
			// figure out how much you can withdraw
			let amount = Math.min(request.amount, remainingAmount);
			amount = Math.min(amount, allStore[request.resourceType] || 0);
			if (amount == 0) continue;
			// update the simulated carry
			if (!queenCarry[request.resourceType]) {
				queenCarry[request.resourceType] = 0;
			}
			queenCarry[request.resourceType] += amount;
			// add a task to supply the target
			supplyTasks.push(Tasks.transfer(request.target, request.resourceType, amount));
		}
		// Step 3: make withdraw tasks to get the needed resources
		let withdrawTasks: Task[] = [];
		let neededResources = _.keys(queenCarry) as ResourceConstant[];
		let targets = _.filter(this.storeStructures,
							   s => _.all(neededResources, // todo: doesn't need to have all resources; causes jam if labs need supply but no minerals
										  resource => (s.store[resource] || 0) >= (queenCarry[resource] || 0)));
		let withdrawTarget: StoreStructure | undefined;
		if (targets.length > 1) {
			withdrawTarget = minBy(targets, target => Pathing.distance(queenPos, target.pos));
		} else {
			withdrawTarget = _.first(targets);
		}
		if (!withdrawTarget) {
			log.warning(`No withdraw target for ${queen.name}@${queen.pos.print}!`);
			return null;
		}
		for (let resourceType of neededResources) {
			withdrawTasks.push(Tasks.withdraw(withdrawTarget!, resourceType, queenCarry[resourceType]));
		}
		// Step 4: put all the tasks in the correct order, set nextPos for each, and chain them together
		tasks = tasks.concat(withdrawTasks, supplyTasks);
		return Tasks.chain(tasks);
	}

	// Builds a series of tasks to withdraw required resources from targets
	private buildWithdrawTaskManifest(queen: Zerg): Task | null {
		let tasks: Task[] = [];
		let transferTarget = this.colony.terminal || this.colony.storage || this.batteries[0];
		// Step 1: empty all contents (this shouldn't be necessary since queen is normally empty at this point)
		if (_.sum(queen.carry) > 0) {
			if (transferTarget) {
				tasks.push(Tasks.transferAll(transferTarget));
			} else {
				log.warning(`No transfer targets for ${queen.name}@${queen.pos.print}!`);
				return null;
			}
		}
		// Step 2: figure out what you need to withdraw from
		let queenCarry = {energy: 0} as { [resourceType: string]: number };
		let allWithdrawRequests = _.compact(_.flatten(_.map(this.assignments[queen.name],
															struc => this.transportRequests.withdrawByID[struc.id])));
		for (let request of allWithdrawRequests) {
			// stop when carry will be full
			let remainingAmount = queen.carryCapacity - _.sum(queenCarry);
			if (remainingAmount == 0) break;
			// figure out how much you can withdraw
			let amount = Math.min(request.amount, remainingAmount);
			if (amount == 0) continue;
			// update the simulated carry
			if (!queenCarry[request.resourceType]) {
				queenCarry[request.resourceType] = 0;
			}
			queenCarry[request.resourceType] += amount;
			// add a task to supply the target
			tasks.push(Tasks.withdraw(request.target, request.resourceType, amount));
		}
		// Step 3: put stuff in terminal/storage
		if (transferTarget) {
			tasks.push(Tasks.transferAll(transferTarget));
		} else {
			log.warning(`No transfer targets for ${queen.name}@${queen.pos.print}!`);
			return null;
		}
		// Step 4: return chained task manifest
		return Tasks.chain(tasks);
	}

	private getChargingSpot(queen: Zerg): RoomPosition {
		let chargeSpots = _.map(bunkerChargingSpots, coord => getPosFromBunkerCoord(coord, this.colony));
		let chargeSpot = (_.first(this.assignments[queen.name]) || queen).pos.findClosestByRange(chargeSpots);
		if (chargeSpot) {
			return chargeSpot;
		} else {
			log.warning(`Could not determine charging spot for queen at ${queen.pos.print}!`);
			return queen.pos;
		}
	}

	private idleActions(queen: Zerg): void {

		// // Refill any empty batteries
		// for (let battery of this.batteries) {
		// 	if (!battery.isFull) {
		// 		let amount = Math.min(battery.storeCapacity - _.sum(battery.store), queen.carryCapacity);
		// 		let target = this.colony.storage || this.colony.storage;
		// 		if (target) {
		// 			queen.task = Tasks.transfer(battery, RESOURCE_ENERGY, amount)
		// 							  .fork(Tasks.withdraw(target, RESOURCE_ENERGY, amount))
		// 			return;
		// 		}
		// 	}
		// }

		// Go to recharging spot and get recharged
		let chargingSpot = this.getChargingSpot(queen);
		queen.goTo(chargingSpot, {range: 0});
		// // TODO: this will cause oscillating behavior where recharge drains some energy and queen leaves to supply it
		// if (queen.pos.getRangeTo(chargingSpot) == 0) {
		// 	let chargingSpawn = _.first(queen.pos.findInRange(this.colony.spawns, 1));
		// 	if (chargingSpawn && !chargingSpawn.spawning) {
		// 		chargingSpawn.renewCreep(queen.creep);
		// 	}
		// }
	}

	private handleQueen(queen: Zerg): void {
		// Does something need withdrawing?
		if (_.any(this.assignments[queen.name], struc => this.transportRequests.withdrawByID[struc.id])) {
			queen.task = this.buildWithdrawTaskManifest(queen);
		}
		// Does something need supplying?
		else if (_.any(this.assignments[queen.name], struc => this.transportRequests.supplyByID[struc.id])) {
			queen.task = this.buildSupplyTaskManifest(queen);
		}
		// Otherwise do idle actions
		if (queen.isIdle) {
			this.idleActions(queen);
		}
	}

	run() {
		for (let queen of this.queens) {
			if (queen.isIdle) {
				this.handleQueen(queen);
			}
			queen.run();
		}
	}
}