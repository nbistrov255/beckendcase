import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity()
export class User {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ unique: true })
    smartshell_id!: string; // ID из SmartShell

    @Column({ nullable: true })
    username!: string;

    @Column({ default: "user" })
    role!: string; // 'user' или 'admin'
}
