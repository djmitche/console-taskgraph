A dependency-graph-solving task executor (sort of like `make`) with pretty
output (sort of like [Listr](https://github.com/SamVerschueren/listr)).

# Usage

```javascript

const {TaskGraph} = require('console-taskgraph');

const options = {};
const graph = new TaskGraph([{
  title: 'A task',
  requires: [],
  provides: ['somevalue', 'anothervalue'],
  run: async (requirements, utils) => {
    return {
      somevalue: 42,
      anothervalue: 43,
    };
  },
}, {
  title: 'Another',
  requires: ['anothervalue'],
  provides: ['thirdvalue'],
  run: async (requirements, utils) => {
    utils.status({message: 'thinking...'});
    return {
      thirdvalue: requirements['anothervalue'] * 10,
    };
  },
}, {
  title: 'Summation',
  requires: ['somevalue'],
  provides: ['sum'],
  run: async (requirements, utils) => {
    return {
      sum: requirements['somevalue'] + requirements['thirdvalue']
    };
  },
}], options);

const {sum} = await graph.run();
console.log(sum);
```

See `example.js` for a demo of some of the display options.

# API

A TaskGraph represents graph of tasks.  Task dependencies are in the form of
named values that some task provides and other tasks require. These are stored
in a map called `context`.  Graph execution (`await graph.run()`) involves
running all tasks, with each task not starting until all of its requirements
have been provided.

The constructor takes a list of tasks.  Each task has the shape

```javascript
{
  title: "..",      // display name for the task
  requires: [ .. ], // keys for values required before this task starts
  provides: [ .. ], // keys for values this task will provide
  run: async (requirements, utils) => ..,
}
```

The async `run` function for a task is given an object `requirements`
containing the values named in `task.requires`.  It should return an object
containing the keys given in `provides`.  As a convenience for tasks with
side-effects, a task with zero or one keys in `provides` may return nothing;
the result is treated as a value of `true` for the single given key.

Any error that occurs during the run results in termination of the entire run.

## Utilities

The `utils` argument to the `run` function contains some useful utilities for
tasks that help with the pretty output:

### waitFor

The `utils.waitFor` function can be used to wait for various things to complete:

  * a Promise (OK, this isn't so useful)
  * a stream, the lines of which are displayed
  * an [Observable](https://github.com/tc39/proposal-observable), the data values from which are displayed

This is a useful way to show progress to the user while handling streams or
other observables. Use it like this:

```javascript
await waitFor(outputStream);
```

### status

The `utils.status` function updates the step's current status.  It accepts options
  * `message` - a short status message such as "Barring the foo"
  * `progress` - progress of this task (as a percentage)

```javascript
utils.status({progress: 13});
```

### skip

The `utils.skip` function flags the task as "skipped".  The task must still return its provided
values, and this function makes that easy:

```javascript
return utils.skip({provides: {key: value}})
```

You may optionally provide a reason for the skip:

```javascript
return utils.skip({provides: {key: value}, reason: 'skipped - already complete'})
```

### step

The `utils.step` function adds a 'step' to this task. Steps are pretty basic: the most recent step
is considered to be 'running' and all previous steps to be finished.  It's useful as a way of
indicating progress from step to step within a larger task.  Call like this:

```javascript
utils.step({title: 'Step 2'})
```

# Locking

In some cases, several tasks may require the same underlying resource.  Locks support delaying
execution of a task until the resources it requires are available.

Configure locks in the `locks` property of the constructor options:

```javascript
const {TaskGraph, Lock} = require('console-taskgraph');
const graph = new TaskGraph([..], {
  locks: {
    gpu: new Lock(1),
  },
});
```

And configure tasks to require locks by including the lock name in the `locks` array for the task:

```javascript
{
  title: 'Build',
  locks: ['gpu'],
  // ...
}
```

The `new Lock(n)` constructs a lock that allows `n` tasks to use it simultaneously.

# Error Handling

Errors that occur in task execution are propagated out of the `run` method.

However, any already-started tasks are allowed to finish before returning (this is
the only choice, as a running Promise cannot be cancelled). Any further errors
from those tasks are indicated in the rendered display, but will not be
propagated.

# Targetting

By default, every task in the Taskgraph is run, and the graph is complete when
no tasks remain unfinished.

With the `target` option, you can specify a set of dependencies which must be
finished.  Only tasks directly or indirectly required to complete those
dependencies will be run.


```js
const graph = new TaskGraph([..], {
  target: ['build-linux'],
});
```

# Renderers

Renderers are responsible for displaying the status of a graph execution as it
occurs. TaskGraph comes with two renderers, one (pretty) for consoles and one
(log lines) for non-TTY output.  These are exported as `ConsoleRenderer` and
`LogRenderer`, respectively.

## ConsoleRenderer

The `ConsoleRenderer` class can take an options object:

```js
new ConsoleRenderer({
  elideCompleted: true, // if true, just count completed tasks (can help keep the display short)
});
```

## LogRenderer

This class has no options.

## Custom Renderers

You can add a custom renderer, if you so choose, by passing a renderer to the
options argument of the constructor:

```javascript
new TaskGraph(tasks, {renderer: new ConsoleRenderer()});
```

That renderer should have the following (sync!) methods:

* `start(nodes)` - Called when the graph has started.  The `nodes` argument is
  a list of graph nodes that will be executed.  Each has a `task` property
  containing the task supplied to the constructor, and a `state` property
  containing its current state (see below).

* `stop()` -- Called when the graph has stopped.

* `update(node, change, value)` -- Called when a node is updated.  The change
  describes the kind of update:

 * `state` -- the given node's state has changed; value is the new state
 * `log` -- a line of log output from the task has arrived
 * `status` -- a status update, with the arguments to `util.status` as value
 * `step` -- a substep has begun; the value has `{title: ..}`
 * `skip` -- a node has been skipped; the value is the reason (this occurs just after the state updates to `skipped`)
 * `fail` -- a node has failed; the value is the error object

## States

Nodes have the following states (with room to add more):

* `pending` -- not yet started
* `running` -- currently executing
* `skipped` -- completed, skipped
* `finished` -- completed
* `failed` -- failed with an exception
