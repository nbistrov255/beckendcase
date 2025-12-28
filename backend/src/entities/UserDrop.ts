import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn } from "typeorm";
import { User } from "./User";
import { Item } from "./Item";
import { Case } from "./Case";

@Entity()
export class UserDrop {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(() => User)
    user!: User;

    @ManyToOne(() => Item)
    item!: Item;

    @ManyToOne(() => Case)
    case!: Case;

    @Column({ default: "in_inventory" })
    status!: string; // 'in_inventory', 'claimed', 'sold'

    @CreateDateColumn()
    created_at!: Date;
}
