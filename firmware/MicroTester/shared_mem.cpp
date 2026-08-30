#include "shared_mem.h"

// 4-byte aligned 48 KB shared memory pool
union SharedMemoryPool g_sharedMem __attribute__((aligned(4)));
