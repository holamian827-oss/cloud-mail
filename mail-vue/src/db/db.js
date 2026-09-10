import Dexie from "dexie";
import {useUserStore} from "@/store/user.js"
import { watch, shallowRef } from "vue";

const userStore = useUserStore();


let db =  shallowRef({})

function createDB() {
    db.value = new Dexie(userStore.user.email);
    // 同一版本号只声明一次 stores，并一次列全所有表
    db.value.version(1).stores({
        draft: '++draftId,createTime',
        att: 'draftId'
    })
}

createDB()

watch(() => userStore.user.email,() => createDB())

export default db;